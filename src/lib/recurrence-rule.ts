/**
 * Read and rebuild the RRULE behind a recurring event in the event form.
 *
 * The form only edits frequency, interval and (weekly) weekdays. Every other
 * part of the original rule - the end date (UNTIL), a count (COUNT), "2nd
 * Tuesday"-style monthly rules, etc. - is carried through unchanged, so saving
 * an edit doesn't quietly turn a series that ends into one that never does.
 */

export const RECURRENCE_FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
] as const;

export interface ParsedRecurrenceRule {
  /** FREQ value, or "NONE" when there is no rule */
  freq: string;
  interval: number;
  /** Weekdays for weekly rules (MO, TU, ...) */
  byDay: string[];
  /** All other parts of the rule, e.g. "UNTIL=20261231T225959Z" */
  extra: string[];
}

// Parts that stay valid whatever the form changes about the frequency
const ALWAYS_KEPT = ["UNTIL", "COUNT", "WKST"];

export function parseRecurrenceRule(
  rule?: string | null
): ParsedRecurrenceRule {
  const result: ParsedRecurrenceRule = {
    freq: "NONE",
    interval: 1,
    byDay: [],
    extra: [],
  };
  if (!rule) return result;

  // Remove RRULE: prefix and any array wrapper
  const clean = rule.replace(/^\[?"?RRULE:/i, "").replace(/"?\]?$/, "");
  const parts = clean.split(";").filter(Boolean);

  const freq = parts.find((p) => p.toUpperCase().startsWith("FREQ="));
  if (freq) result.freq = freq.split("=")[1].toUpperCase();

  for (const part of parts) {
    const [rawKey, value = ""] = part.split("=");
    const key = rawKey.toUpperCase();
    if (key === "FREQ") continue;
    if (key === "INTERVAL") {
      const n = parseInt(value, 10);
      result.interval = Number.isFinite(n) && n > 0 ? n : 1;
    } else if (key === "BYDAY" && result.freq === "WEEKLY") {
      result.byDay = value.split(",").filter(Boolean);
    } else {
      result.extra.push(part);
    }
  }
  return result;
}

/**
 * Build the rule from the form's values. `original` is what the event had
 * when the form opened: its end (UNTIL/COUNT) is always kept, and its other
 * extra parts are kept as long as the frequency hasn't changed.
 */
export function buildRecurrenceRule(
  freq: string,
  interval: number,
  byDay: string[],
  original?: Pick<ParsedRecurrenceRule, "freq" | "extra">
): string {
  if (!freq || freq === "NONE") return "";
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(freq)) return "";

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === "WEEKLY" && byDay.length > 0) {
    parts.push(`BYDAY=${byDay.join(",")}`);
  }

  for (const part of original?.extra ?? []) {
    const key = part.split("=")[0].toUpperCase();
    if (ALWAYS_KEPT.includes(key) || original?.freq === freq) {
      parts.push(part);
    }
  }
  return parts.join(";");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Ends 31 Dec 2026" / "Ends after 10 times", or null for an open-ended rule */
export function describeRecurrenceEnd(extra: string[]): string | null {
  for (const part of extra) {
    const [rawKey, value = ""] = part.split("=");
    const key = rawKey.toUpperCase();
    if (key === "UNTIL") {
      const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
      if (!m) return "Has an end date";
      return `Ends ${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
    }
    if (key === "COUNT") {
      const n = parseInt(value, 10);
      return `Ends after ${n} time${n === 1 ? "" : "s"}`;
    }
  }
  return null;
}

/**
 * The full recurrence list to send to Google when a series' rule is edited:
 * the new RRULE, plus any EXDATE/RDATE lines the series already had (deleted
 * or added occurrences), which a plain replace would otherwise wipe.
 */
export function mergeGoogleRecurrence(
  newRule: string,
  existing?: string[] | null
): string[] {
  const rrule = newRule.startsWith("RRULE:") ? newRule : `RRULE:${newRule}`;
  const others = (existing ?? []).filter((r) => !r.startsWith("RRULE:"));
  return [rrule, ...others];
}
