import { RRule } from "rrule";

import { newDate } from "@/lib/date-utils";
import { normalizeRecurrenceRule } from "@/lib/utils/normalize-recurrence-rules";

export interface NextOccurrence {
  /** Due date of the occurrence that was just completed (date only) */
  completedDueDate: Date;
  /** Due date of the next occurrence (date only, 00:00 UTC) */
  dueDate: Date;
  /** Start date shifted by the same offset as before, if the task had one */
  startDate?: Date;
}

/**
 * Where a recurring task moves to when its current occurrence is completed:
 * the next occurrence after its current due date (or today, if it has
 * none). The start date keeps the same distance to the due date. Returns
 * null if the rule is invalid or has no further occurrences.
 *
 * Shared by completing a task in FluidCalendar and by completions that come
 * in from a synced task list, so both roll the series forward the same way.
 */
export function computeNextOccurrence(task: {
  recurrenceRule: string | null;
  dueDate: Date | null;
  startDate: Date | null;
}): NextOccurrence | null {
  const rule = normalizeRecurrenceRule(task.recurrenceRule);
  if (!rule) return null;

  let rrule: RRule;
  try {
    rrule = RRule.fromString(rule);
  } catch {
    return null;
  }

  // For tasks we only care about the date part
  const completedDueDate = newDate(task.dueDate || newDate());
  completedDueDate.setUTCHours(0, 0, 0, 0);

  // Search from the day after, so the next occurrence is a later day
  const searchDate = newDate(completedDueDate);
  searchDate.setDate(searchDate.getDate() + 1);

  const next = rrule.after(searchDate);
  if (!next) return null;
  next.setUTCHours(0, 0, 0, 0);

  let startDate: Date | undefined;
  if (task.startDate && task.dueDate) {
    const startToDueDays = Math.round(
      (task.dueDate.getTime() - task.startDate.getTime()) /
        (1000 * 60 * 60 * 24)
    );
    startDate = new Date(next);
    startDate.setDate(startDate.getDate() - startToDueDays);
  }

  return { completedDueDate, dueDate: next, startDate };
}
