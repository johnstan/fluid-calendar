import { prisma } from "@/lib/prisma";
import { schedulePushTaskBlock } from "@/lib/task-block-push";
import { GoogleFieldMapper } from "@/lib/task-sync/providers/google-field-mapper";
import { GoogleTaskProvider } from "@/lib/task-sync/providers/google-provider";
import { TaskSyncManager } from "@/lib/task-sync/task-sync-manager";

jest.mock("@/lib/prisma", () => {
  const p = {
    task: {
      create: jest.fn(async ({ data }) => ({ id: "done-copy", ...data })),
      update: jest.fn(async ({ data }) => data),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma: p };
});
jest.mock("@/lib/task-block-push", () => ({
  schedulePushTaskBlock: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mp = prisma as unknown as {
  task: { create: jest.Mock; update: jest.Mock };
};

const mapping = {
  id: "m1",
  externalListId: "list-1",
  projectId: "p1",
  provider: { type: "GOOGLE", userId: "u1" },
};

const localTask = (over = {}) => ({
  id: "t1",
  title: "Home office - shred, scan photos/videos, tidy",
  description: "notes",
  status: "todo",
  isRecurring: true,
  // Every Friday
  recurrenceRule: "FREQ=WEEKLY;BYDAY=FR",
  dueDate: new Date("2026-11-20T00:00:00.000Z"),
  startDate: null,
  duration: 60,
  priority: "medium",
  energyLevel: null,
  preferredTime: null,
  projectId: "p1",
  externalTaskId: "g-1",
  externalUpdatedAt: new Date("2026-11-20T07:00:00.000Z"),
  updatedAt: new Date("2026-11-20T07:30:00.000Z"),
  scheduledStart: new Date("2026-11-20T20:00:00.000Z"),
  tags: [],
  ...over,
});

const completedInGoogle = {
  id: "g-1",
  title: "Home office - shred, scan photos/videos, tidy",
  status: "completed",
  listId: "list-1",
  dueDate: new Date("2026-11-20T00:00:00.000Z"),
  completedDate: new Date("2026-11-20T12:30:00.000Z"),
  lastModified: new Date("2026-11-20T12:30:00.000Z"),
};

const resolve = (task: object, external: object, provider: object) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (new TaskSyncManager() as any).resolveTaskConflict(
    task,
    external,
    provider,
    mapping,
    new GoogleFieldMapper()
  );

describe("completing a synced task in Google Tasks", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rolls a recurring task to its next occurrence and reopens it in Google", async () => {
    const provider = {
      updateTask: jest.fn(async () => ({
        id: "g-1",
        lastModified: new Date("2026-11-20T12:35:00.000Z"),
      })),
    };

    await resolve(localTask(), completedInGoogle, provider);

    // a completed copy for today's occurrence
    expect(mp.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "completed",
        isRecurring: false,
        dueDate: new Date("2026-11-20T00:00:00.000Z"),
        userId: "u1",
      }),
    });
    // the series moves to next Friday, unscheduled, still to do
    expect(mp.task.update.mock.calls[0][0]).toMatchObject({
      where: { id: "t1" },
      data: {
        status: "todo",
        dueDate: new Date("2026-11-27T00:00:00.000Z"),
        scheduledStart: null,
        scheduledEnd: null,
      },
    });
    // Google task reopened with the new due date
    expect(provider.updateTask).toHaveBeenCalledWith("list-1", "g-1", {
      status: "todo",
      dueDate: new Date("2026-11-27T00:00:00.000Z"),
    });
    expect(schedulePushTaskBlock).toHaveBeenCalledWith("u1", "t1");
  });

  it("just marks a one-off task completed", async () => {
    const provider = { updateTask: jest.fn() };
    await resolve(
      localTask({ isRecurring: false, recurrenceRule: null }),
      completedInGoogle,
      provider
    );
    expect(mp.task.create).not.toHaveBeenCalled();
    expect(provider.updateTask).not.toHaveBeenCalled();
    expect(mp.task.update.mock.calls[0][0].data.status).toBe("completed");
  });
});

describe("GoogleTaskProvider", () => {
  it("asks for hidden tasks (completed in the Google apps) and clears completion on reopen", async () => {
    const list = jest.fn().mockResolvedValue({ data: { items: [] } });
    const patch = jest.fn().mockResolvedValue({ data: { id: "g-1" } });
    const provider = new GoogleTaskProvider(
      { tasks: { list, patch } } as unknown as ConstructorParameters<
        typeof GoogleTaskProvider
      >[0],
      "acc",
      "u1"
    );

    await provider.getTasks("list-1");
    expect(list.mock.calls[0][0]).toMatchObject({
      tasklist: "list-1",
      showHidden: true,
    });

    await provider.updateTask("list-1", "g-1", { status: "todo" });
    expect(patch.mock.calls[0][0].requestBody).toEqual({
      status: "needsAction",
      completed: null,
    });
  });
});
