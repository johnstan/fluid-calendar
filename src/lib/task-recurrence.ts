import { RRule, Weekday } from "rrule";

import { normalizeRecurrenceRule } from "@/lib/utils/normalize-recurrence-rules";

/** Weekdays in RRule order: 0 = Monday … 6 = Sunday. */
export const WEEKDAYS = [
  { idx: 0, short: "Mon", letter: "M" },
  { idx: 1, short: "Tue", letter: "T" },
  { idx: 2, short: "Wed", letter: "W" },
  { idx: 3, short: "Thu", letter: "T" },
  { idx: 4, short: "Fri", letter: "F" },
  { idx: 5, short: "Sat", letter: "S" },
  { idx: 6, short: "Sun", letter: "S" },
] as const;

export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface TaskRecurrence {
  freq: RecurrenceFreq;
  interval: number;
  /** Weekly only: which days (0 = Mon … 6 = Sun), sorted, never empty */
  weekdays: number[];
}

const FREQ_TO_RRULE: Record<RecurrenceFreq, number> = {
  daily: RRule.DAILY,
  weekly: RRule.WEEKLY,
  monthly: RRule.MONTHLY,
  yearly: RRule.YEARLY,
};

const RRULE_TO_FREQ: Record<number, RecurrenceFreq> = {
  [RRule.DAILY]: "daily",
  [RRule.WEEKLY]: "weekly",
  [RRule.MONTHLY]: "monthly",
  [RRule.YEARLY]: "yearly",
};

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WORK_WEEK = [0, 1, 2, 3, 4];

function weekdayIndex(day: Weekday | number | string): number | null {
  if (typeof day === "number") return day;
  if (typeof day === "string") {
    const i = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(
      day.slice(-2).toUpperCase()
    );
    return i >= 0 ? i : null;
  }
  return day.weekday;
}

/**
 * Reads the parts of a task's rule the editor deals with. Only the rule's
 * own options are used (origOptions), so nothing derived from a start
 * date (BYHOUR etc.) leaks back into a rebuilt rule. Returns null if the
 * rule can't be parsed or uses a frequency the editor doesn't offer.
 */
export function parseTaskRecurrence(
  rule: string | null | undefined
): TaskRecurrence | null {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return null;
  let opts;
  try {
    opts = RRule.fromString(normalized).origOptions;
  } catch {
    return null;
  }
  const freq = opts.freq !== undefined ? RRULE_TO_FREQ[opts.freq] : undefined;
  if (!freq) return null;

  const raw = opts.byweekday;
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const days = [
    ...new Set(
      list
        .map((d) => weekdayIndex(d as Weekday | number | string))
        .filter((d): d is number => d !== null)
    ),
  ].sort((a, b) => a - b);

  // "Daily on weekdays" (as some apps write it) is a weekly rule here
  if (freq === "daily" && days.length > 0 && (opts.interval ?? 1) === 1) {
    return { freq: "weekly", interval: 1, weekdays: days };
  }

  return {
    freq,
    interval: Math.max(1, opts.interval ?? 1),
    weekdays: freq === "weekly" ? (days.length ? days : [0]) : [],
  };
}

/** Builds the stored rule string (without the RRULE: prefix). */
export function buildTaskRecurrence(r: TaskRecurrence): string {
  const weekly = r.freq === "weekly";
  const days = weekly ? (r.weekdays.length ? r.weekdays : [0]) : [];
  return new RRule({
    freq: FREQ_TO_RRULE[r.freq],
    interval: Math.max(1, Math.floor(r.interval) || 1),
    ...(weekly && { byweekday: [...days].sort((a, b) => a - b) }),
  })
    .toString()
    .replace(/^RRULE:/, "");
}

const sameDays = (a: number[], b: number[]) =>
  a.length === b.length && a.every((d, i) => d === b[i]);

const UNIT: Record<RecurrenceFreq, [string, string]> = {
  daily: ["Daily", "days"],
  weekly: ["Weekly", "weeks"],
  monthly: ["Monthly", "months"],
  yearly: ["Yearly", "years"],
};

/** Short label for lists, e.g. "Mon, Wed", "Weekdays", "Every 2 weeks". */
export function describeTaskRecurrenceShort(
  rule: string | null | undefined
): string | null {
  const r = parseTaskRecurrence(rule);
  if (!r) return null;
  const every = r.interval > 1 ? `Every ${r.interval} ${UNIT[r.freq][1]}` : "";
  if (r.freq !== "weekly") return every || UNIT[r.freq][0];

  let days: string;
  if (sameDays(r.weekdays, ALL_WEEKDAYS)) days = "Daily";
  else if (sameDays(r.weekdays, WORK_WEEK)) days = "Weekdays";
  else if (sameDays(r.weekdays, [5, 6])) days = "Weekends";
  else days = r.weekdays.map((d) => WEEKDAYS[d].short).join(", ");

  if (!every) return days;
  return days === "Daily" ? every : `${every}: ${days}`;
}

/** Sentence for detail views, e.g. "Repeats every week on Mon, Wed". */
export function describeTaskRecurrence(
  rule: string | null | undefined
): string | null {
  const short = describeTaskRecurrenceShort(rule);
  if (!short) return null;
  const r = parseTaskRecurrence(rule)!;
  if (r.freq === "weekly" && r.interval === 1) {
    if (short === "Daily") return "Repeats every day";
    if (short === "Weekdays") return "Repeats every weekday (Mon–Fri)";
    if (short === "Weekends") return "Repeats every weekend (Sat, Sun)";
    return `Repeats every week on ${short}`;
  }
  return `Repeats: ${short.charAt(0).toLowerCase()}${short.slice(1)}`;
}
