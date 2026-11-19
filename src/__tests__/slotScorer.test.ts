import { SlotScorer } from "@/services/scheduling/SlotScorer";
import { AutoScheduleSettings, Task } from "@prisma/client";

import { TimeSlot } from "@/types/scheduling";

// Thu 19 Nov 2026, 13:30 in Amsterdam
const NOW = new Date("2026-11-19T12:30:00Z");

const settings = {
  groupByProject: false,
  highEnergyStart: 7,
  highEnergyEnd: 10,
  mediumEnergyStart: 10,
  mediumEnergyEnd: 13,
  lowEnergyStart: 13,
  lowEnergyEnd: 19,
} as unknown as AutoScheduleSettings;

const slot = (iso: string, minutes = 5): TimeSlot =>
  ({
    start: new Date(iso),
    end: new Date(new Date(iso).getTime() + minutes * 60000),
    score: 0,
    conflicts: [],
    energyLevel: null,
    isWithinWorkHours: true,
    hasBufferTime: false,
  }) as TimeSlot;

const task = (over: Partial<Task>): Task =>
  ({
    id: "t1",
    title: "Mesalazine",
    duration: 5,
    priority: "high",
    preferredTime: "morning",
    energyLevel: null,
    projectId: null,
    dueDate: new Date("2026-11-20T00:00:00Z"), // due Friday (date-only)
    ...over,
  }) as Task;

describe("SlotScorer", () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(NOW));
  afterAll(() => jest.useRealTimers());

  const scorer = new SlotScorer(settings, new Map(), "Europe/Amsterdam");
  const total = (s: TimeSlot, t: Task) => scorer.scoreSlot(s, t).total;

  it("prefers the earliest morning slot on the due day", () => {
    const t = task({});
    const fri0700 = total(slot("2026-11-20T06:00:00Z"), t); // 07:00 local
    const fri1155 = total(slot("2026-11-20T10:55:00Z"), t); // 11:55 local
    expect(fri0700).toBeGreaterThan(fri1155);
  });

  it("does not reward slots for being closer to the deadline", () => {
    const t = task({});
    const early = scorer.scoreSlot(slot("2026-11-20T06:00:00Z"), t).factors;
    const late = scorer.scoreSlot(slot("2026-11-20T15:00:00Z"), t).factors;
    expect(early.deadlineProximity).toBe(late.deadlineProximity);
  });

  it("scores slots after the deadline below on-time slots", () => {
    const t = task({ preferredTime: null });
    const fri = total(slot("2026-11-20T19:00:00Z"), t); // Fri 20:00 local
    const sat = total(slot("2026-11-21T06:00:00Z"), t); // Sat 07:00 local
    expect(fri).toBeGreaterThan(sat);
  });

  it("uses the user's timezone for the morning window", () => {
    const t = task({});
    // 12:30 Amsterdam = 11:30 UTC: outside 05-12 local, inside 05-12 UTC
    const f = scorer.scoreSlot(slot("2026-11-20T11:30:00Z"), t).factors;
    expect(f.timePreference).toBe(0);
    // 06:30 Amsterdam = 05:30 UTC: inside the local morning window
    const g = scorer.scoreSlot(slot("2026-11-20T05:30:00Z"), t).factors;
    expect(g.timePreference).toBeGreaterThan(0);
  });

  it("still boosts overdue tasks above tasks due later", () => {
    const overdue = task({ dueDate: new Date("2026-11-17T00:00:00Z") });
    const later = task({ dueDate: new Date("2026-11-27T00:00:00Z") });
    const s = slot("2026-11-20T06:00:00Z");
    expect(
      scorer.scoreSlot(s, overdue).factors.deadlineProximity
    ).toBeGreaterThan(scorer.scoreSlot(s, later).factors.deadlineProximity);
  });
});
