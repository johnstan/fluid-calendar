/**
 * @jest-environment node
 */
import { getGoogleCalendarClient } from "@/lib/google-calendar";
import {
  planIncrementalChanges,
  syncGoogleFeed,
  syncWindow,
} from "@/lib/google-calendar-sync";
import { prisma } from "@/lib/prisma";

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("@/lib/google-calendar", () => ({
  getGoogleCalendarClient: jest.fn(),
}));
jest.mock("@/lib/prisma", () => {
  const tx = {
    calendarEvent: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
    calendarFeed: { update: jest.fn(async () => ({})) },
  };
  return {
    prisma: {
      calendarFeed: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tx = (prisma as any).__tx;
const findFeed = prisma.calendarFeed.findUnique as jest.Mock;
const list = jest.fn();
const get = jest.fn();
(getGoogleCalendarClient as jest.Mock).mockResolvedValue({
  events: { list, get },
});

const window = syncWindow(new Date("2026-11-20T08:00:00Z"));
const timed = (id: string, start: string, end: string, extra = {}) => ({
  id,
  status: "confirmed",
  summary: id,
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
});

const feed = (over = {}) => ({
  id: "feed-1",
  userId: "u1",
  accountId: "acc",
  url: "cal@x",
  syncToken: "tok-1",
  fullSyncAt: new Date(Date.now() - 60 * 60 * 1000), // an hour ago
  ...over,
});

describe("planIncrementalChanges", () => {
  it("removes cancelled and out-of-window events, upserts the rest", () => {
    const plan = planIncrementalChanges(
      "feed-1",
      [
        timed("moved", "2026-11-21T09:00:00Z", "2026-11-21T10:00:00Z"),
        { id: "gone", status: "cancelled" },
        timed("far", "2028-03-01T09:00:00Z", "2028-03-01T10:00:00Z"),
      ],
      new Map(),
      window
    );
    expect(plan.removeExternalIds.sort()).toEqual(["far", "gone"]);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0]).toMatchObject({
      feedId: "feed-1",
      externalEventId: "moved",
      title: "moved",
    });
  });
});

describe("syncGoogleFeed", () => {
  beforeEach(() => jest.clearAllMocks());

  it("applies only the changes when it has a recent sync token", async () => {
    findFeed.mockResolvedValue(feed());
    list.mockResolvedValueOnce({
      data: {
        items: [
          timed("e1", "2026-11-21T09:00:00Z", "2026-11-21T10:00:00Z"),
          timed("e2", "2026-11-22T09:00:00Z", "2026-11-22T10:00:00Z"),
          { id: "e3", status: "cancelled" },
        ],
        nextSyncToken: "tok-2",
      },
    });
    tx.calendarEvent.findMany.mockResolvedValueOnce([
      { id: "db-1", externalEventId: "e1" },
    ]);

    const result = await syncGoogleFeed("feed-1", "u1");

    expect(result).toEqual({ mode: "incremental", events: 3 });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ syncToken: "tok-1", singleEvents: true })
    );
    expect(list.mock.calls[0][0]).not.toHaveProperty("timeMin");
    // existing event updated in place (keeps its id), new one created
    expect(tx.calendarEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "db-1" } })
    );
    expect(tx.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.calendarEvent.deleteMany.mock.calls[0][0].where.OR).toEqual([
      { externalEventId: { in: ["e3"] } },
      { recurringEventId: { in: ["e3"] } },
    ]);
    expect(tx.calendarEvent.createMany).not.toHaveBeenCalled();
    expect(tx.calendarFeed.update.mock.calls[0][0].data.syncToken).toBe(
      "tok-2"
    );
  });

  it("falls back to a full sync when Google says the token is gone (410)", async () => {
    findFeed.mockResolvedValue(feed());
    list
      .mockRejectedValueOnce(Object.assign(new Error("Gone"), { code: 410 }))
      .mockResolvedValueOnce({
        data: {
          items: [timed("e1", "2026-11-21T09:00:00Z", "2026-11-21T10:00:00Z")],
          nextSyncToken: "fresh",
        },
      });

    const result = await syncGoogleFeed("feed-1", "u1");

    expect(result.mode).toBe("full");
    expect(list.mock.calls[1][0]).toHaveProperty("timeMin");
    expect(tx.calendarEvent.createMany).toHaveBeenCalledTimes(1);
    const data = tx.calendarFeed.update.mock.calls[0][0].data;
    expect(data.syncToken).toBe("fresh");
    expect(data.fullSyncAt).toBeInstanceOf(Date);
  });

  it("does a full sync without a token, daily, or when asked", async () => {
    list.mockResolvedValue({ data: { items: [], nextSyncToken: "t" } });

    findFeed.mockResolvedValue(feed({ syncToken: null }));
    expect((await syncGoogleFeed("feed-1", "u1")).mode).toBe("full");

    findFeed.mockResolvedValue(
      feed({ fullSyncAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    );
    expect((await syncGoogleFeed("feed-1", "u1")).mode).toBe("full");

    findFeed.mockResolvedValue(feed());
    expect((await syncGoogleFeed("feed-1", "u1", { full: true })).mode).toBe(
      "full"
    );
  });

  it("rethrows other Google errors", async () => {
    findFeed.mockResolvedValue(feed());
    list.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { code: 403 })
    );
    await expect(syncGoogleFeed("feed-1", "u1")).rejects.toThrow("Forbidden");
  });
});
