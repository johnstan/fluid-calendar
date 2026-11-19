import { z } from "zod";

/** One availability window within a day, in the user's local time ("HH:MM"). */
export interface ScheduleBlock {
  start: string;
  end: string;
}

/** Weekly blocks keyed by weekday: "0" = Sunday ... "6" = Saturday. */
export type ScheduleBlocks = Partial<Record<string, ScheduleBlock[]>>;

/** Shape the scheduler needs; matches the Prisma `Schedule` row. */
export interface ScheduleLike {
  id: string;
  name: string;
  isDefault: boolean;
  blocks: unknown;
}

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const scheduleBlockSchema = z
  .object({
    start: z.string().regex(TIME, "Use HH:MM"),
    end: z.string().regex(TIME, "Use HH:MM"),
  })
  .refine((b) => toMinutes(b.end) > toMinutes(b.start), {
    message: "End must be after start",
  });

export const scheduleBlocksSchema = z.record(
  z.enum(["0", "1", "2", "3", "4", "5", "6"]),
  z.array(scheduleBlockSchema)
);

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().max(20).nullable().optional(),
  isDefault: z.boolean().optional(),
  blocks: scheduleBlocksSchema.optional(),
  sortOrder: z.number().int().optional(),
});

/** "HH:MM" -> minutes after midnight ("24:00" -> 1440). */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Parse stored blocks defensively: drops malformed entries, sorts each day
 * and merges overlapping/adjacent windows.
 */
export function parseScheduleBlocks(raw: unknown): ScheduleBlocks {
  const out: ScheduleBlocks = {};
  if (!raw || typeof raw !== "object") return out;
  for (let day = 0; day < 7; day++) {
    const list = (raw as Record<string, unknown>)[String(day)];
    if (!Array.isArray(list)) continue;
    const valid = list
      .map((b) => scheduleBlockSchema.safeParse(b))
      .filter((r) => r.success)
      .map((r) => r.data as ScheduleBlock)
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    const merged: ScheduleBlock[] = [];
    for (const b of valid) {
      const last = merged[merged.length - 1];
      if (last && toMinutes(b.start) <= toMinutes(last.end)) {
        if (toMinutes(b.end) > toMinutes(last.end)) last.end = b.end;
      } else {
        merged.push({ ...b });
      }
    }
    if (merged.length) out[String(day)] = merged;
  }
  return out;
}

/** Total available minutes per week, for display ("27h 15m / week"). */
export function weeklyMinutes(blocks: ScheduleBlocks): number {
  return Object.values(blocks).reduce(
    (sum, day) =>
      sum +
      (day ?? []).reduce(
        (s, b) => s + toMinutes(b.end) - toMinutes(b.start),
        0
      ),
    0
  );
}
