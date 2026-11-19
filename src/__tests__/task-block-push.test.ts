import { GaxiosError } from "gaxios";

import {
  createGoogleEvent,
  deleteGoogleEvent,
  updateGoogleEvent,
} from "@/lib/google-calendar";
import { prisma } from "@/lib/prisma";
import {
  TASK_BLOCK_DESCRIPTION,
  cleanupOrphanTaskBlocks,
  pushTaskBlock,
  removeAllTaskBlocks,
  repushDirtyBlocks,
} from "@/lib/task-block-push";

jest.mock("@/lib/google-calendar", () => ({
  createGoogleEvent: jest.fn(),
  updateGoogleEvent: jest.fn(),
  deleteGoogleEvent: jest.fn(),
}));

jest.mock("@/lib/prisma", () => ({
  prisma: {
    task: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    autoScheduleSettings: {
      findUnique: jest.fn(),
    },
    userSettings: {
      findUnique: jest.fn(),
    },
    calendarFeed: {
      findUnique: jest.fn(),
    },
    calendarEvent: {
      findMany: jest.fn(),
      delete: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockPrisma = prisma as unknown as {
  task: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  autoScheduleSettings: { findUnique: jest.Mock };
  userSettings: { findUnique: jest.Mock };
  calendarFeed: { findUnique: jest.Mock };
  calendarEvent: {
    findMany: jest.Mock;
    delete: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};
const mockCreate = createGoogleEvent as jest.Mock;
const mockUpdate = updateGoogleEvent as jest.Mock;
const mockDelete = deleteGoogleEvent as jest.Mock;

const USER = "user-1";

function gaxios404(): GaxiosError {
  const err = Object.create(GaxiosError.prototype) as GaxiosError;
  err.message = "Not Found";
  // @ts-expect-error partial response is sufficient for the helper
  err.response = { status: 404 };
  return err;
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    userId: USER,
    title: "Write report",
    status: "todo",
    scheduledStart: new Date("2026-06-12T14:00:00Z"),
    scheduledEnd: new Date("2026-06-12T15:00:00Z"),
    blockEventId: null,
    blockFeedId: null,
    blockDirty: false,
    ...overrides,
  };
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    pushTasksToCalendar: true,
    pushTasksFeedId: "feed-1",
    ...overrides,
  };
}

function googleFeed(id = "feed-1", url = "gcal-id-1") {
  return {
    id,
    type: "GOOGLE",
    url,
    accountId: "acct-1",
    account: { id: "acct-1" },
    userId: USER,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.task.update.mockResolvedValue({});
  mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.calendarEvent.findMany.mockResolvedValue([]);
  mockPrisma.calendarEvent.delete.mockResolvedValue({});
  mockPrisma.calendarEvent.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.calendarEvent.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.userSettings.findUnique.mockResolvedValue({
    userId: USER,
    timeZone: "America/Chicago",
  });
});

describe("pushTaskBlock state transitions", () => {
  test("creates event and stores blockEventId + blockFeedId when task is scheduled and push enabled", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(baseTask());
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockCreate.mockResolvedValue({ id: "evt-1" });

    await pushTaskBlock(USER, "task-1");

    expect(mockCreate).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      expect.objectContaining({
        title: "Write report",
        timeZone: "America/Chicago",
      })
    );
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockEventId: "evt-1",
          blockFeedId: "feed-1",
          blockDirty: false,
        }),
      })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("updates existing event when task moves on the same feed", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({ blockEventId: "evt-1", blockFeedId: "feed-1" })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockUpdate.mockResolvedValue({});

    await pushTaskBlock(USER, "task-1");

    expect(mockUpdate).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-1",
      expect.anything()
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("deletes event when task is completed", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({
        status: "completed",
        blockEventId: "evt-1",
        blockFeedId: "feed-1",
      })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockDelete.mockResolvedValue({});

    await pushTaskBlock(USER, "task-1");

    expect(mockDelete).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-1",
      "single"
    );
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockEventId: null,
          blockDirty: false,
        }),
      })
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("deletes event when push is disabled but event exists", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({ blockEventId: "evt-1", blockFeedId: "feed-1" })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(
      settings({ pushTasksToCalendar: false })
    );
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockDelete.mockResolvedValue({});

    await pushTaskBlock(USER, "task-1");

    expect(mockDelete).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("feed switch: deletes from old feed and creates on new feed", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({ blockEventId: "evt-1", blockFeedId: "feed-old" })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(
      settings({ pushTasksFeedId: "feed-new" })
    );
    mockPrisma.calendarFeed.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === "feed-new"
            ? googleFeed("feed-new", "gcal-new")
            : googleFeed("feed-old", "gcal-old")
        )
    );
    mockDelete.mockResolvedValue({});
    mockCreate.mockResolvedValue({ id: "evt-2" });

    await pushTaskBlock(USER, "task-1");

    expect(mockDelete).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-old",
      "evt-1",
      "single"
    );
    expect(mockCreate).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-new",
      expect.anything()
    );
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockEventId: "evt-2",
          blockFeedId: "feed-new",
        }),
      })
    );
  });
});

describe("pushTaskBlock error handling", () => {
  test("create failure marks task dirty without throwing", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(baseTask());
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockCreate.mockRejectedValue(new Error("rate limited"));

    await expect(pushTaskBlock(USER, "task-1")).resolves.toBeUndefined();

    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ blockDirty: true }),
      })
    );
  });

  test("404 on update clears blockEventId and marks dirty so next push recreates", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({ blockEventId: "evt-gone", blockFeedId: "feed-1" })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockUpdate.mockRejectedValue(gaxios404());

    await pushTaskBlock(USER, "task-1");

    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockEventId: null,
          blockDirty: true,
        }),
      })
    );
  });

  test("404 on delete is treated as success and clears block state", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(
      baseTask({
        status: "completed",
        blockEventId: "evt-gone",
        blockFeedId: "feed-1",
      })
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockDelete.mockRejectedValue(gaxios404());

    await pushTaskBlock(USER, "task-1");

    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockEventId: null,
          blockDirty: false,
        }),
      })
    );
  });

  test("non-GOOGLE feed is rejected without calling Google APIs", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(baseTask());
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue({
      ...googleFeed(),
      type: "OUTLOOK",
    });

    await pushTaskBlock(USER, "task-1");

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("removeAllTaskBlocks", () => {
  test("deletes every pushed event and clears block state on each task", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      baseTask({ id: "t1", blockEventId: "e1", blockFeedId: "feed-1" }),
      baseTask({ id: "t2", blockEventId: "e2", blockFeedId: "feed-1" }),
    ]);
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockDelete.mockResolvedValue({});

    await removeAllTaskBlocks(USER);

    expect(mockDelete).toHaveBeenCalledTimes(2);
    const clearCalls = mockPrisma.task.update.mock.calls.filter(
      ([arg]) => arg.data.blockEventId === null
    );
    expect(clearCalls).toHaveLength(2);
  });

  test("clears local state even when blockFeedId is missing", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      baseTask({ id: "t1", blockEventId: "e1", blockFeedId: null }),
    ]);

    await removeAllTaskBlocks(USER);

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1" },
        data: expect.objectContaining({ blockEventId: null }),
      })
    );
  });
});

describe("repushDirtyBlocks", () => {
  test("queries dirty tasks and newly scheduled tasks, skips processing when push disabled", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(
      settings({ pushTasksToCalendar: false })
    );

    await repushDirtyBlocks(USER);

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER,
          OR: expect.arrayContaining([{ blockDirty: true }]),
        }),
      })
    );
    // push disabled → no per-task processing
    expect(mockPrisma.task.findUnique).not.toHaveBeenCalled();
  });

  test("pushes each found task when enabled", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      baseTask({ id: "t1", blockDirty: true }),
      baseTask({ id: "t2" }),
    ]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.task.findUnique.mockResolvedValue(baseTask());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockCreate.mockResolvedValue({ id: "evt-x" });

    await repushDirtyBlocks(USER);

    // each task flows through pushTaskBlock → task.findUnique called per task
    expect(mockPrisma.task.findUnique).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe("concurrent pushes", () => {
  test("two overlapping pushes for an unpushed task create only one event", async () => {
    // A tiny in-memory task row, so the second push sees what the first wrote
    let row = baseTask();
    mockPrisma.task.findUnique.mockImplementation(async () => ({ ...row }));
    mockPrisma.task.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data };
        return row;
      }
    );
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockCreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20)); // Google round-trip
      return { id: "evt-1" };
    });
    mockUpdate.mockResolvedValue({});

    await Promise.all([
      pushTaskBlock(USER, "task-1"),
      pushTaskBlock(USER, "task-1"),
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(row.blockEventId).toBe("evt-1");
  });
});

describe("cleanupOrphanTaskBlocks", () => {
  beforeEach(() => {
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockPrisma.task.findMany.mockResolvedValue([{ blockEventId: "evt-kept" }]);
    mockPrisma.calendarEvent.findMany.mockResolvedValue([
      { id: "row-kept", externalEventId: "evt-kept" },
      { id: "row-orphan", externalEventId: "evt-orphan" },
    ]);
    mockDelete.mockResolvedValue(undefined);
  });

  test("deletes pushed blocks no task references, keeps referenced ones", async () => {
    await cleanupOrphanTaskBlocks(USER);

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-orphan",
      "single"
    );
    expect(mockPrisma.calendarEvent.delete).toHaveBeenCalledWith({
      where: { id: "row-orphan" },
    });
  });

  test("only looks at events carrying the FluidCalendar marker", async () => {
    await cleanupOrphanTaskBlocks(USER);

    expect(mockPrisma.calendarEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feedId: "feed-1",
          description: TASK_BLOCK_DESCRIPTION,
        }),
      })
    );
  });

  test("treats an already-deleted event as cleaned up", async () => {
    mockDelete.mockRejectedValue(gaxios404());

    await cleanupOrphanTaskBlocks(USER);

    expect(mockPrisma.calendarEvent.delete).toHaveBeenCalledWith({
      where: { id: "row-orphan" },
    });
  });

  test("does nothing when push is disabled", async () => {
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(
      settings({ pushTasksToCalendar: false })
    );

    await cleanupOrphanTaskBlocks(USER);

    expect(mockPrisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("repushDirtyBlocks reconciliation", () => {
  test("re-pushes a block whose event drifted from its task, even if not flagged", async () => {
    // Not dirty, already has an event - but the event sits at the old time
    const task = baseTask({
      id: "t-moved",
      blockEventId: "evt-old",
      blockFeedId: "feed-1",
    });
    mockPrisma.task.findMany
      .mockResolvedValueOnce([]) // dirty / newly scheduled: none
      .mockResolvedValueOnce([task]) // tasks with a pushed block
      .mockResolvedValue([{ blockEventId: "evt-old" }]); // orphan check
    mockPrisma.calendarEvent.findMany
      .mockResolvedValueOnce([
        {
          externalEventId: "evt-old",
          start: new Date("2026-06-12T09:00:00Z"), // task is at 14:00
          end: new Date("2026-06-12T10:00:00Z"),
        },
      ])
      .mockResolvedValue([]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.task.findUnique.mockResolvedValue(task);
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockUpdate.mockResolvedValue({});

    await repushDirtyBlocks(USER);

    expect(mockUpdate).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-old",
      expect.objectContaining({ start: task.scheduledStart })
    );
    // local copy updated so the next run sees it as in sync
    expect(mockPrisma.calendarEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalEventId: "evt-old" } })
    );
  });

  test("leaves blocks that already match their task alone", async () => {
    const task = baseTask({
      id: "t-ok",
      blockEventId: "evt-ok",
      blockFeedId: "feed-1",
    });
    mockPrisma.task.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task])
      .mockResolvedValue([{ blockEventId: "evt-ok" }]);
    mockPrisma.calendarEvent.findMany
      .mockResolvedValueOnce([
        {
          externalEventId: "evt-ok",
          start: task.scheduledStart,
          end: task.scheduledEnd,
        },
      ])
      .mockResolvedValue([]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());

    await repushDirtyBlocks(USER);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("removes the block of a task that lost its slot", async () => {
    const task = baseTask({
      id: "t-unscheduled",
      blockEventId: "evt-stale",
      blockFeedId: "feed-1",
      scheduledStart: null,
      scheduledEnd: null,
    });
    mockPrisma.task.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task])
      .mockResolvedValue([]);
    mockPrisma.calendarEvent.findMany
      .mockResolvedValueOnce([
        {
          externalEventId: "evt-stale",
          start: new Date("2026-06-12T09:00:00Z"),
          end: new Date("2026-06-12T10:00:00Z"),
        },
      ])
      .mockResolvedValue([]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.task.findUnique.mockResolvedValue(task);
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    mockDelete.mockResolvedValue(undefined);

    await repushDirtyBlocks(USER);

    expect(mockDelete).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-stale",
      "single"
    );
    expect(mockPrisma.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { externalEventId: "evt-stale" },
    });
  });
});

describe("repushDirtyBlocks with a re-added push calendar", () => {
  test("repairs a stale feed reference and fixes the drifted block", async () => {
    // Task still points at a feed that was removed and re-added (new id),
    // but its event lives in the current push calendar at the old time
    const task = baseTask({
      id: "t-stale",
      blockEventId: "evt-stale-feed",
      blockFeedId: "feed-removed",
    });
    mockPrisma.task.findMany
      .mockResolvedValueOnce([]) // dirty / newly scheduled
      .mockResolvedValueOnce([task]) // tasks with a pushed block
      .mockResolvedValue([{ blockEventId: "evt-stale-feed" }]); // orphan check
    mockPrisma.calendarEvent.findMany
      .mockResolvedValueOnce([
        {
          externalEventId: "evt-stale-feed",
          start: new Date("2026-06-12T08:30:00Z"),
          end: new Date("2026-06-12T09:00:00Z"),
        },
      ])
      .mockResolvedValue([]);
    mockPrisma.autoScheduleSettings.findUnique.mockResolvedValue(settings());
    mockPrisma.calendarFeed.findUnique.mockResolvedValue(googleFeed());
    // after the repair the task points at the current feed
    mockPrisma.task.findUnique.mockResolvedValue({
      ...task,
      blockFeedId: "feed-1",
    });
    mockUpdate.mockResolvedValue({});

    await repushDirtyBlocks(USER);

    expect(mockPrisma.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t-stale"] }, userId: USER },
      data: { blockFeedId: "feed-1" },
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      "acct-1",
      USER,
      "gcal-id-1",
      "evt-stale-feed",
      expect.objectContaining({ start: task.scheduledStart })
    );
  });
});
