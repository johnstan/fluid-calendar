/**
 * @jest-environment node
 */
import { runAutoScheduleOnce } from "@/lib/auto-schedule-runner";
import { prisma } from "@/lib/prisma";
import { runTaskSync } from "@/lib/task-sync/scheduler";

const syncTaskList = jest.fn();

jest.mock("@/lib/task-sync/task-sync-manager", () => ({
  TaskSyncManager: jest.fn().mockImplementation(() => ({ syncTaskList })),
}));
jest.mock("@/lib/auto-schedule-runner", () => ({
  runAutoScheduleOnce: jest.fn(async () => []),
}));
jest.mock("@/lib/google-calendar-sync", () => ({ syncGoogleFeed: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("@/lib/prisma", () => ({
  prisma: { taskListMapping: { findMany: jest.fn() } },
}));

const findMany = prisma.taskListMapping.findMany as jest.Mock;
const result = (rolledForward: number) => ({
  imported: 0,
  updated: rolledForward,
  deleted: 0,
  rolledForward,
});

describe("scheduled task sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([
      { id: "m1", provider: { userId: "u1" } },
      { id: "m2", provider: { userId: "u1" } },
    ]);
  });

  it("runs Auto Schedule (once per user) when a recurring task was rolled forward", async () => {
    syncTaskList
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2));
    await runTaskSync();
    expect(runAutoScheduleOnce).toHaveBeenCalledTimes(1);
    expect(runAutoScheduleOnce).toHaveBeenCalledWith("u1");
  });

  it("doesn't reschedule when nothing was rolled forward", async () => {
    syncTaskList.mockResolvedValue(result(0));
    await runTaskSync();
    expect(runAutoScheduleOnce).not.toHaveBeenCalled();
  });
});
