import { TaskStatus } from "@/types/task";

import { newDate } from "./date-utils";

export const DEFAULT_TASK_COLOR = "#f2fbff";
/**
 * The moment a task's due date passes. Due dates without a time (Google
 * Tasks only keeps the date, and recurring tasks roll over to a date) are
 * stored as 00:00 UTC; for those the deadline is the END of that calendar
 * day in local time, not its start (01:00 in Amsterdam). Due dates with an
 * explicit time are used as-is.
 */
export function dueDeadline(dueDate: Date | string): Date {
  const due = newDate(dueDate);
  const isDateOnly =
    due.getUTCHours() === 0 &&
    due.getUTCMinutes() === 0 &&
    due.getUTCSeconds() === 0 &&
    due.getUTCMilliseconds() === 0;
  if (!isDateOnly) return due;
  return new Date(
    due.getUTCFullYear(),
    due.getUTCMonth(),
    due.getUTCDate(),
    23,
    59,
    59,
    999
  );
}

/**
 * Checks if a task is overdue based on its due date and completion status
 * @param task The task object or task properties to check
 * @param now Current time (defaults to now)
 * @returns boolean indicating if the task is overdue
 */
export function isTaskOverdue(
  task: {
    dueDate?: Date | string | null;
    status?: string;
  },
  now: Date = newDate()
): boolean {
  return (
    !!task.dueDate &&
    task.status !== TaskStatus.COMPLETED &&
    dueDeadline(task.dueDate) < now
  );
}
