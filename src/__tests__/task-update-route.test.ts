/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { PUT } from "@/app/api/tasks/[id]/route";

import { prisma } from "@/lib/prisma";

jest.mock("@/lib/auth/api-auth", () => ({
  authenticateRequest: jest.fn(async () => ({ userId: "user-1" })),
}));
jest.mock("@/lib/task-block-push", () => ({
  schedulePushTaskBlock: jest.fn(),
  deleteTaskBlockEvent: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: jest.fn(), update: jest.fn() },
    taskListMapping: { findFirst: jest.fn() },
  },
}));

const mockFind = prisma.task.findUnique as jest.Mock;
const mockUpdate = prisma.task.update as jest.Mock;
const mockMapping = prisma.taskListMapping.findFirst as jest.Mock;

const put = (body: Record<string, unknown>) =>
  PUT(
    new NextRequest("http://localhost/api/tasks/t1", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "t1" }) }
  );

describe("PUT /api/tasks/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockResolvedValue({
      id: "t1",
      status: "todo",
      isRecurring: false,
      projectId: "p1",
      tags: [],
    });
    mockMapping.mockResolvedValue(null);
    mockUpdate.mockImplementation(async ({ data }) => ({ id: "t1", ...data }));
  });

  it("sets project and schedule as plain foreign keys (no relation mix)", async () => {
    const res = await put({
      priority: "medium",
      projectId: "p1",
      scheduleId: "s1",
      tagIds: [],
    });
    expect(res!.status).toBe(200);
    const { data } = mockUpdate.mock.calls[0][0];
    expect(data).toMatchObject({
      priority: "medium",
      projectId: "p1",
      scheduleId: "s1",
    });
    expect(data.project).toBeUndefined();
  });

  it("clears the project with null and leaves it alone when omitted", async () => {
    await put({ projectId: null });
    expect(mockUpdate.mock.calls[0][0].data.projectId).toBeNull();

    await put({ priority: "low" });
    expect("projectId" in mockUpdate.mock.calls[1][0].data).toBe(false);
  });
});
