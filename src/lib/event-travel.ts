import { z } from "zod";

/** Max travel time either side of an event (minutes). */
export const MAX_TRAVEL_MINUTES = 240;

export const travelInputSchema = z.object({
  eventId: z.string().min(1),
  beforeMinutes: z.number().int().min(0).max(MAX_TRAVEL_MINUTES),
  afterMinutes: z.number().int().min(0).max(MAX_TRAVEL_MINUTES),
  allOccurrences: z.boolean().optional().default(false),
});

export interface TravelEventRef {
  id: string;
  externalEventId?: string | null;
  recurringEventId?: string | null;
}

export interface TravelTimeRow {
  eventKey: string;
  beforeMinutes: number;
  afterMinutes: number;
}

/** Key for this single occurrence (provider id survives re-syncs). */
export function eventInstanceKey(event: TravelEventRef): string {
  return event.externalEventId || event.id;
}

/** Key shared by every occurrence of a recurring series, if any. */
export function eventSeriesKey(event: TravelEventRef): string | null {
  return event.recurringEventId || null;
}

/** All keys a travel row could be stored under for these events. */
export function travelLookupKeys(events: TravelEventRef[]): string[] {
  const keys = new Set<string>();
  for (const e of events) {
    keys.add(eventInstanceKey(e));
    const series = eventSeriesKey(e);
    if (series) keys.add(series);
  }
  return [...keys];
}

/** Travel for one event: a per-occurrence row wins over the series row. */
export function findTravelFor(
  event: TravelEventRef,
  byKey: Map<string, TravelTimeRow>
): TravelTimeRow | null {
  const own = byKey.get(eventInstanceKey(event));
  if (own) return own;
  const series = eventSeriesKey(event);
  return (series && byKey.get(series)) || null;
}

/**
 * Returns copies of the events with start/end widened by their travel
 * time, so anything that treats events as busy (the auto-scheduler)
 * keeps that time free. All-day events and events without travel are
 * returned unchanged.
 */
export function applyTravelTimes<
  T extends TravelEventRef & { start: Date; end: Date; allDay?: boolean },
>(events: T[], rows: TravelTimeRow[]): T[] {
  if (rows.length === 0) return events;
  const byKey = new Map(rows.map((r) => [r.eventKey, r]));
  return events.map((event) => {
    if (event.allDay) return event;
    const travel = findTravelFor(event, byKey);
    if (!travel || (!travel.beforeMinutes && !travel.afterMinutes)) {
      return event;
    }
    return {
      ...event,
      start: new Date(event.start.getTime() - travel.beforeMinutes * 60_000),
      end: new Date(event.end.getTime() + travel.afterMinutes * 60_000),
    };
  });
}
