import { RRule } from "rrule";

import {
  buildTaskRecurrence,
  describeTaskRecurrence,
  describeTaskRecurrenceShort,
  parseTaskRecurrence,
} from "@/lib/task-recurrence";

describe("task recurrence helpers", () => {
  it("parses weekly days, with or without the RRULE: prefix", () => {
    expect(parseTaskRecurrence("RRULE:FREQ=WEEKLY;BYDAY=WE,MO")).toEqual({
      freq: "weekly",
      interval: 1,
      weekdays: [0, 2],
    });
    expect(parseTaskRecurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toEqual({
      freq: "weekly",
      interval: 2,
      weekdays: [4],
    });
  });

  it("treats daily-with-days as weekly and defaults weekly to Monday", () => {
    expect(
      parseTaskRecurrence("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR")?.weekdays
    ).toEqual([0, 1, 2, 3, 4]);
    expect(parseTaskRecurrence("FREQ=WEEKLY")?.weekdays).toEqual([0]);
    expect(parseTaskRecurrence("FREQ=DAILY")).toEqual({
      freq: "daily",
      interval: 1,
      weekdays: [],
    });
  });

  it("handles junk and Outlook-style monthly", () => {
    expect(parseTaskRecurrence(null)).toBeNull();
    expect(parseTaskRecurrence("nonsense")).toBeNull();
    expect(parseTaskRecurrence("FREQ=ABSOLUTEMONTHLY;INTERVAL=1")?.freq).toBe(
      "monthly"
    );
  });

  it("builds clean rules that round-trip and recur on the chosen days", () => {
    const rule = buildTaskRecurrence({
      freq: "weekly",
      interval: 1,
      weekdays: [4, 0, 2],
    });
    expect(rule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR");
    expect(parseTaskRecurrence(rule)?.weekdays).toEqual([0, 2, 4]);

    // Thu 19 Nov 2026 -> next occurrence is Fri 20 Nov
    const next = RRule.fromString(rule).after(
      new Date(Date.UTC(2026, 10, 19, 12))
    );
    expect(next?.getUTCDay()).toBe(5);

    expect(
      buildTaskRecurrence({ freq: "daily", interval: 3, weekdays: [1] })
    ).toBe("FREQ=DAILY;INTERVAL=3");
  });

  it("describes rules for lists and detail views", () => {
    expect(describeTaskRecurrenceShort("FREQ=WEEKLY;BYDAY=MO,WE")).toBe(
      "Mon, Wed"
    );
    expect(
      describeTaskRecurrenceShort("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
    ).toBe("Weekdays");
    expect(
      describeTaskRecurrenceShort("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU")
    ).toBe("Daily");
    expect(describeTaskRecurrenceShort("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")).toBe(
      "Every 2 weeks: Tue"
    );
    expect(describeTaskRecurrenceShort("FREQ=MONTHLY")).toBe("Monthly");
    expect(describeTaskRecurrence("FREQ=WEEKLY;BYDAY=MO,WE")).toBe(
      "Repeats every week on Mon, Wed"
    );
    expect(describeTaskRecurrence("FREQ=DAILY;INTERVAL=2")).toBe(
      "Repeats: every 2 days"
    );
  });
});
