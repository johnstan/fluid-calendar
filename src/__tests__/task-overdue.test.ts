import { dueDeadline, isTaskOverdue } from "@/lib/task-utils";

// Tests run with TZ=UTC, so "local end of day" is 23:59:59.999Z
describe("due dates and overdue", () => {
  const due = "2026-11-20T00:00:00.000Z"; // date-only: due on 20 Nov

  it("treats a date-only due date as the end of that day", () => {
    expect(dueDeadline(due).toISOString()).toBe("2026-11-20T23:59:59.999Z");
  });

  it("is not overdue during the due day, only after it", () => {
    const task = { dueDate: due, status: "todo" };
    expect(isTaskOverdue(task, new Date("2026-11-20T06:24:00Z"))).toBe(false);
    expect(isTaskOverdue(task, new Date("2026-11-20T23:00:00Z"))).toBe(false);
    expect(isTaskOverdue(task, new Date("2026-11-21T00:30:00Z"))).toBe(true);
  });

  it("uses explicit due times as-is and ignores completed tasks", () => {
    const timed = { dueDate: "2026-11-20T14:30:00.000Z", status: "todo" };
    expect(isTaskOverdue(timed, new Date("2026-11-20T15:00:00Z"))).toBe(true);
    expect(
      isTaskOverdue(
        { dueDate: due, status: "completed" },
        new Date("2026-11-25T00:00:00Z")
      )
    ).toBe(false);
    expect(isTaskOverdue({ dueDate: null, status: "todo" })).toBe(false);
  });
});
