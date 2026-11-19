import { CalendarService } from "@/services/scheduling/CalendarService";
import { TimeSlotManagerImpl } from "@/services/scheduling/TimeSlotManager";
import { AutoScheduleSettings, Task } from "@prisma/client";

import {
  ScheduleBlocks,
  parseScheduleBlocks,
  weeklyMinutes,
} from "@/lib/schedules";

import { TimeSlot } from "@/types/scheduling";

// Thu 19 Nov 2026, 13:30 in Amsterdam
const NOW = new Date("2026-11-19T12:30:00Z");
const TZ = "Europe/Amsterdam";

const settings = {
  workDays: "[1,2,3,4,5]",
  workHourStart: 9,
  workHourEnd: 17,
  bufferMinutes: 0,
  groupByProject: false,
  selectedCalendars: "[]",
} as unknown as AutoScheduleSettings;

const calendarService = {} as CalendarService;

// Motion "Evenings & Weekends"
const eveningsAndWeekends: ScheduleBlocks = {
  "0": [
    { start: "07:45", end: "14:00" },
    { start: "17:00", end: "18:00" },
  ],
  "1": [{ start: "17:45", end: "21:30" }],
  "2": [{ start: "17:45", end: "21:30" }],
  "3": [{ start: "17:45", end: "21:30" }],
  "4": [{ start: "17:45", end: "21:30" }],
  "5": [{ start: "17:45", end: "21:30" }],
  "6": [
    { start: "07:45", end: "14:00" },
    { start: "17:00", end: "18:00" },
  ],
};

type Internals = {
  generateScheduleSlots: (
    duration: number,
    start: Date,
    end: Date,
    blocks: ScheduleBlocks
  ) => TimeSlot[];
  resolveSchedule: (task: Partial<Task>) => ScheduleBlocks | null;
};

const local = (d: Date) =>
  d.toLocaleString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

describe("schedule-based slot generation", () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(NOW));
  afterAll(() => jest.useRealTimers());

  const manager = new TimeSlotManagerImpl(settings, calendarService, TZ, [
    {
      id: "ew",
      name: "Evenings",
      isDefault: false,
      blocks: eveningsAndWeekends,
    },
    {
      id: "work",
      name: "Work hours",
      isDefault: true,
      blocks: { "1": [{ start: "09:00", end: "17:30" }] },
    },
  ]) as unknown as Internals;

  const slots = manager.generateScheduleSlots(
    30,
    NOW,
    new Date("2026-11-22T23:00:00Z"), // through Sunday
    eveningsAndWeekends
  );

  it("only produces slots inside the schedule's blocks, in local time", () => {
    const first = slots.slice(0, 3).map((s) => local(s.start));
    // Thursday evening block starts 17:45 local (16:45 UTC)
    expect(first).toEqual(["Thu 17:45", "Thu 18:00", "Thu 18:15"]);

    const parts = (d: Date) => {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(d);
      const get = (t: string) => f.find((p) => p.type === t)!.value;
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
        get("weekday")
      );
      return { day, hm: `${get("hour")}:${get("minute")}` };
    };
    for (const s of slots) {
      const start = parts(s.start);
      const end = parts(s.end);
      const blocks = eveningsAndWeekends[String(start.day)] ?? [];
      const inside = blocks.some(
        (b) => start.hm >= b.start && end.hm <= b.end && end.day === start.day
      );
      expect({ slot: local(s.start), inside }).toEqual({
        slot: local(s.start),
        inside: true,
      });
      expect(s.isWithinWorkHours).toBe(true);
    }
  });

  it("fits the whole task inside a block", () => {
    const fri = slots.filter((s) => local(s.start).startsWith("Fri"));
    expect(local(fri[fri.length - 1].start)).toBe("Fri 21:00");
  });

  it("covers weekend blocks, including short ones", () => {
    const sat = slots
      .filter((s) => local(s.start).startsWith("Sat"))
      .map((s) => local(s.start));
    expect(sat[0]).toBe("Sat 07:45");
    expect(sat).toContain("Sat 17:00");
    expect(sat).toContain("Sat 17:30");
    expect(sat).not.toContain("Sat 15:00");
  });

  it("never offers a slot in the past", () => {
    for (const s of slots)
      expect(s.start.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("uses the task's schedule, else the default schedule", () => {
    const own = manager.resolveSchedule({ scheduleId: "ew" } as Partial<Task>);
    const fallback = manager.resolveSchedule({
      scheduleId: null,
    } as Partial<Task>);
    expect(own?.["6"]?.length).toBe(2);
    expect(Object.keys(fallback ?? {})).toEqual(["1"]);
  });

  it("falls back to working hours when there is no default", () => {
    const m = new TimeSlotManagerImpl(settings, calendarService, TZ, [
      { id: "x", name: "X", isDefault: false, blocks: {} },
    ]) as unknown as Internals;
    expect(m.resolveSchedule({ scheduleId: null } as Partial<Task>)).toBeNull();
  });
});

describe("parseScheduleBlocks", () => {
  it("sorts, merges overlaps and drops invalid blocks", () => {
    const parsed = parseScheduleBlocks({
      "1": [
        { start: "13:00", end: "17:00" },
        { start: "09:00", end: "13:00" },
        { start: "16:00", end: "18:00" },
        { start: "20:00", end: "19:00" }, // ends before it starts
        { start: "nonsense", end: "10:00" },
      ],
      "9": [{ start: "09:00", end: "10:00" }], // not a weekday
    });
    expect(parsed).toEqual({ "1": [{ start: "09:00", end: "18:00" }] });
    expect(weeklyMinutes(parsed)).toBe(9 * 60);
  });
});
