import {
  buildRecurrenceRule,
  describeRecurrenceEnd,
  mergeGoogleRecurrence,
  parseRecurrenceRule,
} from "@/lib/recurrence-rule";

describe("recurrence rule round trip", () => {
  it("keeps the series end date when the form saves unchanged", () => {
    const rule = "RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z;BYDAY=MO,WE";
    const p = parseRecurrenceRule(rule);
    expect(p.freq).toBe("WEEKLY");
    expect(p.byDay).toEqual(["MO", "WE"]);
    expect(buildRecurrenceRule(p.freq, p.interval, p.byDay, p)).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T225959Z"
    );
  });

  it("keeps COUNT and the end date even when the frequency changes", () => {
    const p = parseRecurrenceRule("FREQ=MONTHLY;BYDAY=2TU;COUNT=6");
    expect(p.byDay).toEqual([]);
    expect(buildRecurrenceRule("MONTHLY", 1, [], p)).toBe(
      "FREQ=MONTHLY;BYDAY=2TU;COUNT=6"
    );
    // Switching to weekly drops the monthly-only BYDAY=2TU but keeps COUNT
    expect(buildRecurrenceRule("WEEKLY", 2, ["FR"], p)).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=6"
    );
  });

  it("builds a plain rule for a new series", () => {
    expect(buildRecurrenceRule("DAILY", 1, [])).toBe("FREQ=DAILY");
    expect(buildRecurrenceRule("NONE", 1, [])).toBe("");
  });

  it("describes how a series ends", () => {
    expect(describeRecurrenceEnd(["UNTIL=20261231T225959Z"])).toBe(
      "Ends 31 Dec 2026"
    );
    expect(describeRecurrenceEnd(["COUNT=1"])).toBe("Ends after 1 time");
    expect(describeRecurrenceEnd(["WKST=MO"])).toBeNull();
  });

  it("keeps Google's deleted/added occurrences when replacing the rule", () => {
    expect(
      mergeGoogleRecurrence("FREQ=DAILY;UNTIL=20261231", [
        "RRULE:FREQ=DAILY",
        "EXDATE;TZID=Europe/Amsterdam:20261125T090000",
      ])
    ).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20261231",
      "EXDATE;TZID=Europe/Amsterdam:20261125T090000",
    ]);
  });
});
