import { reuseEventIds } from "@/lib/calendar-event-ids";

describe("reuseEventIds", () => {
  it("keeps ids of events that still exist and leaves new ones alone", () => {
    const rows = [
      { externalEventId: "g1", title: "Moved" },
      { externalEventId: "g3", title: "New" },
      { externalEventId: null, title: "No provider id" },
    ];
    const out = reuseEventIds(rows, [
      { id: "db-1", externalEventId: "g1" },
      { id: "db-2", externalEventId: "g2" }, // deleted in Google
    ]);
    expect(out[0]).toEqual({
      id: "db-1",
      externalEventId: "g1",
      title: "Moved",
    });
    expect(out[1]).not.toHaveProperty("id");
    expect(out[2]).not.toHaveProperty("id");
  });

  it("hands each old id out only once", () => {
    const out = reuseEventIds(
      [{ externalEventId: "g1" }, { externalEventId: "g1" }] as {
        id?: string;
        externalEventId: string;
      }[],
      [{ id: "db-1", externalEventId: "g1" }]
    );
    expect(out[0].id).toBe("db-1");
    expect(out[1].id).toBeUndefined();
  });
});
