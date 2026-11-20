import { Prisma } from "@prisma/client";
import { calendar_v3 } from "googleapis";

import { reuseEventIds } from "@/lib/calendar-event-ids";
import { createAllDayDate, newDate, newDateFromYMD } from "@/lib/date-utils";
import { getGoogleCalendarClient } from "@/lib/google-calendar";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const LOG_SOURCE = "GoogleCalendarSync";

// Helper function to process recurrence rules
export function processRecurrenceRule(
  recurrence: string[] | null | undefined,
  startDate?: Date
): string | undefined {
  if (!recurrence || recurrence.length === 0) return undefined;

  // Find the RRULE (should be the first one starting with RRULE:)
  const rrule = recurrence.find((r) => r.startsWith("RRULE:"));
  if (!rrule) return undefined;

  // For yearly rules, ensure both BYMONTH and BYMONTHDAY are present
  if (rrule.includes("FREQ=YEARLY") && startDate) {
    const hasMonth = rrule.includes("BYMONTH=");
    const hasMonthDay = rrule.includes("BYMONTHDAY=");

    if (!hasMonth || !hasMonthDay) {
      // Start with the base rule
      let parts = rrule.split(";");

      // Remove any existing incomplete parts we'll replace
      parts = parts.filter(
        (part) =>
          !part.startsWith("BYMONTH=") && !part.startsWith("BYMONTHDAY=")
      );

      // Add the complete month and day
      parts.push(`BYMONTH=${startDate.getMonth() + 1}`);
      parts.push(`BYMONTHDAY=${startDate.getDate()}`);

      return parts.join(";");
    }
  }

  return rrule;
}

export async function fetchAllEvents(
  calendarClient: calendar_v3.Calendar,
  params: calendar_v3.Params$Resource$Events$List
): Promise<calendar_v3.Schema$Event[]> {
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res = await calendarClient.events.list({ ...params, pageToken });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken as string | undefined;
  } while (pageToken);
  return items;
}

export class FeedNotFoundError extends Error {}

type GoogleEvent = calendar_v3.Schema$Event;
type EventRow = Prisma.CalendarEventCreateManyInput;

/** A full re-import runs at least this often, even with a valid sync token */
export const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Events kept locally: from 1 Jan this year until 1 Jan next year. */
export function syncWindow(now: Date = newDate()) {
  return {
    timeMin: newDateFromYMD(now.getFullYear(), 0, 1),
    timeMax: newDateFromYMD(now.getFullYear() + 1, 0, 1),
  };
}

/** Pages through events.list, also returning the final nextSyncToken. */
async function listAllEvents(
  calendarClient: calendar_v3.Calendar,
  params: calendar_v3.Params$Resource$Events$List
): Promise<{ items: GoogleEvent[]; nextSyncToken: string | null }> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined = undefined;
  let nextSyncToken: string | null = null;
  do {
    const res = await calendarClient.events.list({ ...params, pageToken });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken as string | undefined;
    nextSyncToken = (res.data.nextSyncToken as string | undefined) ?? null;
  } while (pageToken);
  return { items, nextSyncToken };
}

/** Recurrence rule of each series the events belong to (one fetch per series). */
async function fetchSeriesRecurrence(
  calendarClient: calendar_v3.Calendar,
  calendarId: string,
  events: GoogleEvent[]
): Promise<Map<string, string[]>> {
  const series = new Map<string, string[]>();
  for (const event of events) {
    const id = event.recurringEventId;
    if (!id || series.has(id)) continue;
    try {
      const master = await calendarClient.events.get({
        calendarId,
        eventId: id,
      });
      const recurrence = master.data?.recurrence;
      series.set(id, Array.isArray(recurrence) ? recurrence : []);
    } catch (error) {
      logger.warn(
        "Failed to fetch recurring series",
        {
          seriesId: id,
          error: error instanceof Error ? error.message : String(error),
        },
        LOG_SOURCE
      );
      series.set(id, []); // don't retry this series in this run
    }
  }
  return series;
}

/** Database row for one Google event (an occurrence when singleEvents). */
export function toEventRow(
  feedId: string,
  event: GoogleEvent,
  seriesRecurrence: Map<string, string[]>
): EventRow | null {
  if (!event.start?.dateTime && !event.start?.date) return null;

  const recurrence = event.recurringEventId
    ? seriesRecurrence.get(event.recurringEventId)
    : event.recurrence;
  const isAllDay = !event.start.dateTime;

  return {
    feedId,
    externalEventId: event.id,
    title: event.summary || "Untitled Event",
    description: event.description || "",
    start: isAllDay
      ? createAllDayDate(event.start.date || "")
      : newDate(event.start.dateTime || event.start.date || ""),
    end: isAllDay
      ? createAllDayDate(event.end?.date || "")
      : newDate(event.end?.dateTime || event.end?.date || ""),
    location: event.location,
    isRecurring: !!event.recurringEventId || !!recurrence?.length,
    recurringEventId: event.recurringEventId,
    recurrenceRule: processRecurrenceRule(
      recurrence,
      newDate(event.start.dateTime || event.start.date || "")
    ),
    allDay: isAllDay,
    isFree: event.transparency === "transparent",
    status: event.status,
    sequence: event.sequence,
    created: event.created ? newDate(event.created) : undefined,
    lastModified: event.updated ? newDate(event.updated) : undefined,
    organizer: event.organizer
      ? {
          name: event.organizer.displayName,
          email: event.organizer.email,
        }
      : undefined,
    attendees: event.attendees?.map((a: calendar_v3.Schema$EventAttendee) => ({
      name: a.displayName,
      email: a.email,
      status: a.responseStatus,
    })),
  };
}

const inWindow = (row: EventRow, w: { timeMin: Date; timeMax: Date }) =>
  new Date(row.end as Date) > w.timeMin &&
  new Date(row.start as Date) < w.timeMax;

/**
 * What an incremental change list means for the local copy: events to
 * remove (cancelled in Google, or moved outside the kept window) and rows
 * to insert or update.
 */
export function planIncrementalChanges(
  feedId: string,
  changed: GoogleEvent[],
  seriesRecurrence: Map<string, string[]>,
  window: { timeMin: Date; timeMax: Date }
): { removeExternalIds: string[]; upsertRows: EventRow[] } {
  const removeExternalIds: string[] = [];
  const upsertRows: EventRow[] = [];
  for (const event of changed) {
    if (!event.id) continue;
    if (event.status === "cancelled") {
      removeExternalIds.push(event.id);
      continue;
    }
    const row = toEventRow(feedId, event, seriesRecurrence);
    if (row && inWindow(row, window)) upsertRows.push(row);
    else removeExternalIds.push(event.id);
  }
  return { removeExternalIds, upsertRows };
}

function isSyncTokenGone(error: unknown): boolean {
  const e = error as { code?: unknown; response?: { status?: number } };
  return Number(e?.code) === 410 || e?.response?.status === 410;
}

export interface SyncResult {
  mode: "full" | "incremental";
  /** Events stored (full) or changes applied (incremental) */
  events: number;
}

/**
 * Brings one Google calendar feed's local copy up to date. Normally only
 * the changes since the last sync are fetched (Google sync token); a full
 * re-import runs when there is no token, when Google invalidates it (410),
 * at least once a day (so the kept window rolls forward), or when asked.
 * Used by the sync button, the background scheduler and event edits.
 * Throws on failure (GaxiosError for Google API errors).
 */
export async function syncGoogleFeed(
  feedId: string,
  userId: string,
  options: { full?: boolean } = {}
): Promise<SyncResult> {
  // Get the feed and ensure it belongs to the user
  const feed = await prisma.calendarFeed.findUnique({
    where: { id: feedId, userId },
    include: { account: true },
  });

  if (!feed || !feed.accountId || !feed.url) {
    throw new FeedNotFoundError("Feed not found");
  }
  const calendarId = feed.url;

  const client = await getGoogleCalendarClient(feed.accountId, userId);

  const fullSyncDue =
    !feed.fullSyncAt ||
    newDate().getTime() - feed.fullSyncAt.getTime() > FULL_SYNC_INTERVAL_MS;

  if (!options.full && feed.syncToken && !fullSyncDue) {
    try {
      return await incrementalSync(
        client,
        feed.id,
        userId,
        calendarId,
        feed.syncToken
      );
    } catch (error) {
      if (!isSyncTokenGone(error)) throw error;
      logger.info(
        "Google sync token expired; doing a full sync",
        { feedId },
        LOG_SOURCE
      );
    }
  }
  return fullSync(client, feed.id, userId, calendarId);
}

async function incrementalSync(
  client: calendar_v3.Calendar,
  feedId: string,
  userId: string,
  calendarId: string,
  syncToken: string
): Promise<SyncResult> {
  const { items, nextSyncToken } = await listAllEvents(client, {
    calendarId,
    singleEvents: true,
    syncToken,
  });

  const seriesRecurrence = await fetchSeriesRecurrence(
    client,
    calendarId,
    items.filter((e) => e.status !== "cancelled")
  );
  const { removeExternalIds, upsertRows } = planIncrementalChanges(
    feedId,
    items,
    seriesRecurrence,
    syncWindow()
  );

  await prisma.$transaction(
    async (tx) => {
      if (removeExternalIds.length) {
        await tx.calendarEvent.deleteMany({
          where: {
            feedId,
            OR: [
              { externalEventId: { in: removeExternalIds } },
              // A cancelled series removes its occurrences
              { recurringEventId: { in: removeExternalIds } },
            ],
          },
        });
      }
      if (upsertRows.length) {
        const existing = await tx.calendarEvent.findMany({
          where: {
            feedId,
            externalEventId: {
              in: upsertRows.map((r) => r.externalEventId as string),
            },
          },
          select: { id: true, externalEventId: true },
        });
        const idByExternal = new Map(
          existing.map((e) => [e.externalEventId, e.id])
        );
        for (const row of upsertRows) {
          const id = idByExternal.get(row.externalEventId as string);
          if (id) {
            await tx.calendarEvent.update({
              where: { id },
              data: row as Prisma.CalendarEventUncheckedUpdateInput,
            });
          } else {
            await tx.calendarEvent.create({ data: row });
          }
        }
      }
      await tx.calendarFeed.update({
        where: { id: feedId, userId },
        data: {
          lastSync: newDate(),
          error: null,
          // Keep the old token if Google didn't send a new one
          ...(nextSyncToken && { syncToken: nextSyncToken }),
        },
      });
    },
    { timeout: 60000 }
  );

  if (items.length) {
    logger.info(
      "Incremental Google sync applied",
      {
        feedId,
        changed: items.length,
        removed: removeExternalIds.length,
        upserted: upsertRows.length,
      },
      LOG_SOURCE
    );
  }
  return { mode: "incremental", events: items.length };
}

async function fullSync(
  client: calendar_v3.Calendar,
  feedId: string,
  userId: string,
  calendarId: string
): Promise<SyncResult> {
  const window = syncWindow();
  const { items, nextSyncToken } = await listAllEvents(client, {
    calendarId,
    timeMin: window.timeMin.toISOString(),
    timeMax: window.timeMax.toISOString(),
    singleEvents: true,
  });

  const seriesRecurrence = await fetchSeriesRecurrence(
    client,
    calendarId,
    items
  );
  const rows = items
    .filter((e) => e.status !== "cancelled")
    .map((e) => toEventRow(feedId, e, seriesRecurrence))
    .filter((r): r is EventRow => r !== null);

  // Replace the feed's events atomically, so the calendar and the
  // auto-scheduler never see the feed half-empty mid-sync. Events keep their
  // database id across syncs (matched on Google's event id), so pages and
  // per-event settings referring to an id stay valid.
  await prisma.$transaction(
    async (tx) => {
      const existing = await tx.calendarEvent.findMany({
        where: { feedId },
        select: { id: true, externalEventId: true },
      });
      const stableRows = reuseEventIds(rows, existing);
      await tx.calendarEvent.deleteMany({ where: { feedId } });
      if (stableRows.length) {
        await tx.calendarEvent.createMany({ data: stableRows });
      }
      await tx.calendarFeed.update({
        where: { id: feedId, userId },
        data: {
          lastSync: newDate(),
          fullSyncAt: newDate(),
          error: null,
          // Without a token the next sync is a full one again
          syncToken: nextSyncToken,
        },
      });
    },
    { timeout: 60000 }
  );

  logger.info(
    "Full Google sync done",
    { feedId, events: rows.length, incrementalReady: !!nextSyncToken },
    LOG_SOURCE
  );
  return { mode: "full", events: rows.length };
}
