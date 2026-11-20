/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { POST } from "@/app/api/tasks/schedule-all/route";
import { scheduleAllTasksForUser } from "@/services/scheduling/TaskSchedulingService";

import { repushDirtyBlocks } from "@/lib/task-block-push";

jest.mock("@/lib/auth/api-auth", () => ({
  authenticateRequest: jest.fn(async () => ({ userId: "user-1" })),
}));
jest.mock("@/services/scheduling/TaskSchedulingService", () => ({
  scheduleAllTasksForUser: jest.fn(),
}));
jest.mock("@/lib/task-block-push", () => ({
  repushDirtyBlocks: jest.fn(async () => undefined),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockSchedule = scheduleAllTasksForUser as jest.Mock;
const mockRepush = repushDirtyBlocks as jest.Mock;

const request = () =>
  new NextRequest("http://localhost/api/tasks/schedule-all", {
    method: "POST",
  });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("POST /api/tasks/schedule-all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRepush.mockImplementation(async () => undefined);
  });

  it("runs once when two requests overlap, and both get the result", async () => {
    mockSchedule.mockImplementation(
      () => new Promise((r) => setTimeout(() => r([{ id: "t1" }]), 30))
    );

    const [a, b] = await Promise.all([POST(request()), POST(request())]);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockRepush).toHaveBeenCalledTimes(1);
    expect(await a!.json()).toEqual([{ id: "t1" }]);
    expect(await b!.json()).toEqual([{ id: "t1" }]);
  });

  it("runs again for a request after the previous run finished", async () => {
    mockSchedule.mockResolvedValue([]);

    await POST(request());
    await POST(request());

    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });

  it("does not stay locked after a failed run", async () => {
    mockSchedule.mockRejectedValueOnce(new Error("boom"));
    mockSchedule.mockResolvedValueOnce([]);

    const failed = await POST(request());
    const next = await POST(request());

    expect(failed!.status).toBe(500);
    expect(next!.status).toBe(200);
  });

  it("responds without waiting for the calendar push, and pushes never overlap", async () => {
    mockSchedule.mockResolvedValue([{ id: "t1" }]);
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    mockRepush.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
    });

    // Both responses arrive while the first push is still running
    const first = await POST(request());
    await flush();
    const second = await POST(request());
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    expect(mockRepush).toHaveBeenCalledTimes(1);

    releases.shift()!();
    await flush();
    expect(mockRepush).toHaveBeenCalledTimes(2); // queued push runs after
    releases.shift()!();
    await flush();
    expect(maxActive).toBe(1);
  });
});
