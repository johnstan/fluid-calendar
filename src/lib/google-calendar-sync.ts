import { Prisma } from "@prisma/client";
import { calendar_v3 } from "googleapis";

import { createAllDayDate, newDate, newDateFromYMD } from "@/lib/date-utils";
import { getGoogleCalendarClient } from "@/lib/google-calendar";
import { prisma } from "@/lib/prisma";

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

/**
 * Re-imports one Google calendar feed (this year + next year's start) into the
 * database. Used by the manual sync button (PUT /api/calendar/google) and the
 * background scheduler. Throws on failure (GaxiosError for Google API errors).
 */
export async function syncGoogleFeed(
  feedId: string,
  userId: string
): Promise<{ events: number }> {
  // Get the feed and ensure it belongs to the user
  const feed = await prisma.calendarFeed.findUnique({
    where: { id: feedId, userId },
    include: { account: true },
  });

  if (!feed || !feed.accountId || !feed.url) {
    throw new FeedNotFoundError("Feed not found");
  }
  const calendarId = feed.url;

  const googleCalendarClient = await getGoogleCalendarClient(
    feed.accountId,
    userId
  );

  // Fetch all events with pagination
  const events = await fetchAllEvents(googleCalendarClient, {
    calendarId,
    timeMin: newDateFromYMD(newDate().getFullYear(), 0, 1).toISOString(),
    timeMax: newDateFromYMD(newDate().getFullYear() + 1, 0, 1).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  // Pre-fetch the recurrence rule of each recurring series (once per series)
  const masterEvents = new Map<string, string[]>();
  for (const event of events) {
    const eventId = event.recurringEventId;
    if (eventId && typeof eventId === "string" && !masterEvents.has(eventId)) {
      try {
        const masterEvent = await googleCalendarClient.events.get({
          calendarId,
          eventId,
        });
        const recurrence = masterEvent.data?.recurrence;
        masterEvents.set(eventId, Array.isArray(recurrence) ? recurrence : []);
      } catch (error) {
        console.error("Failed to fetch master event:", error);
        masterEvents.set(eventId, []); // don't retry this series in this run
      }
    }
  }

  const rows: Prisma.CalendarEventCreateManyInput[] = [];
  for (const event of events) {
    // Skip events without start time
    if (!event.start?.dateTime && !event.start?.date) continue;

    const recurrence = event.recurringEventId
      ? masterEvents.get(event.recurringEventId)
      : event.recurrence;
    const isAllDay = !event.start.dateTime;

    rows.push({
      feedId: feed.id,
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
      attendees: event.attendees?.map(
        (a: calendar_v3.Schema$EventAttendee) => ({
          name: a.displayName,
          email: a.email,
          status: a.responseStatus,
        })
      ),
    });
  }

  // Replace the feed's events atomically, so the calendar and the
  // auto-scheduler never see the feed half-empty mid-sync
  await prisma.$transaction(
    async (tx) => {
      await tx.calendarEvent.deleteMany({ where: { feedId } });
      if (rows.length) await tx.calendarEvent.createMany({ data: rows });
      await tx.calendarFeed.update({
        where: { id: feedId, userId },
        data: { lastSync: newDate(), error: null },
      });
    },
    { timeout: 60000 }
  );

  return { events: rows.length };
}
