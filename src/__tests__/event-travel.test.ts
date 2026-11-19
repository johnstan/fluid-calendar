import {
  applyTravelTimes,
  findTravelFor,
  travelInputSchema,
  travelLookupKeys,
} from "@/lib/event-travel";

const at = (iso: string) => new Date(iso);

const meeting = {
  id: "local-1",
  externalEventId: "g-1",
  recurringEventId: null,
  start: at("2026-11-20T10:00:00Z"),
  end: at("2026-11-20T11:00:00Z"),
  allDay: false,
};

describe("event travel time", () => {
  it("widens an event by its travel time without mutating it", () => {
    const [out] = applyTravelTimes(
      [meeting],
      [{ eventKey: "g-1", beforeMinutes: 30, afterMinutes: 15 }]
    );
    expect(out.start.toISOString()).toBe("2026-11-20T09:30:00.000Z");
    expect(out.end.toISOString()).toBe("2026-11-20T11:15:00.000Z");
    expect(meeting.start.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });

  it("leaves all-day events and events without travel unchanged", () => {
    const allDay = {
      ...meeting,
      id: "x",
      externalEventId: "g-2",
      allDay: true,
    };
    const other = { ...meeting, id: "y", externalEventId: "g-3" };
    const out = applyTravelTimes(
      [allDay, other],
      [{ eventKey: "g-2", beforeMinutes: 30, afterMinutes: 30 }]
    );
    expect(out[0]).toBe(allDay);
    expect(out[1]).toBe(other);
  });

  it("uses the series setting for occurrences, with per-occurrence override", () => {
    const occ = (id: string) => ({
      ...meeting,
      id,
      externalEventId: `series_${id}`,
      recurringEventId: "series",
    });
    const byKey = new Map([
      ["series", { eventKey: "series", beforeMinutes: 20, afterMinutes: 20 }],
      ["series_b", { eventKey: "series_b", beforeMinutes: 0, afterMinutes: 0 }],
    ]);
    expect(findTravelFor(occ("a"), byKey)?.beforeMinutes).toBe(20);
    expect(findTravelFor(occ("b"), byKey)?.beforeMinutes).toBe(0);
    expect(travelLookupKeys([occ("a"), occ("b")]).sort()).toEqual([
      "series",
      "series_a",
      "series_b",
    ]);
  });

  it("falls back to the local id for events without a provider id", () => {
    const local = { ...meeting, externalEventId: null };
    const [out] = applyTravelTimes(
      [local],
      [{ eventKey: "local-1", beforeMinutes: 10, afterMinutes: 0 }]
    );
    expect(out.start.toISOString()).toBe("2026-11-20T09:50:00.000Z");
  });

  it("validates input bounds", () => {
    const ok = { eventId: "e", beforeMinutes: 30, afterMinutes: 0 };
    expect(travelInputSchema.safeParse(ok).success).toBe(true);
    expect(
      travelInputSchema.safeParse({ ...ok, beforeMinutes: -5 }).success
    ).toBe(false);
    expect(
      travelInputSchema.safeParse({ ...ok, afterMinutes: 999 }).success
    ).toBe(false);
  });
});
