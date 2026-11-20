/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { DELETE, PATCH } from "@/app/api/tasks/[id]/comments/[commentId]/route";
import { GET, POST } from "@/app/api/tasks/[id]/comments/route";

import { prisma } from "@/lib/prisma";

jest.mock("@/lib/auth/api-auth", () => ({
  authenticateRequest: jest.fn(async () => ({ userId: "u1" })),
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
    task: { findFirst: jest.fn() },
    taskComment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }) => ({ id: "c1", ...data })),
      update: jest.fn(async ({ data }) => ({ id: "c1", ...data })),
      delete: jest.fn(async () => ({})),
    },
  },
}));

const taskFind = prisma.task.findFirst as jest.Mock;
const c = prisma.taskComment as unknown as Record<string, jest.Mock>;

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/tasks/t1/comments", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const taskParams = { params: Promise.resolve({ id: "t1" }) };
const commentParams = {
  params: Promise.resolve({ id: "t1", commentId: "c1" }),
};

describe("task comments API", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists comments oldest first for the user's own task", async () => {
    taskFind.mockResolvedValue({ id: "t1" });
    c.findMany.mockResolvedValue([{ id: "c1", body: "idea" }]);
    const res = (await GET(req("GET"), taskParams))!;
    expect(res.status).toBe(200);
    expect(c.findMany).toHaveBeenCalledWith({
      where: { taskId: "t1", userId: "u1" },
      orderBy: { createdAt: "asc" },
    });
    expect(taskFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", userId: "u1" } })
    );
  });

  it("adds a trimmed comment and rejects empty ones", async () => {
    taskFind.mockResolvedValue({ id: "t1" });
    const res = (await POST(
      req("POST", { body: "  next: try v2  " }),
      taskParams
    ))!;
    expect(res.status).toBe(201);
    expect(c.create).toHaveBeenCalledWith({
      data: { taskId: "t1", userId: "u1", body: "next: try v2" },
    });

    const empty = (await POST(req("POST", { body: "   " }), taskParams))!;
    expect(empty.status).toBe(400);
    expect(c.create).toHaveBeenCalledTimes(1);
  });

  it("404s on someone else's task", async () => {
    taskFind.mockResolvedValue(null);
    expect((await GET(req("GET"), taskParams))!.status).toBe(404);
    expect((await POST(req("POST", { body: "x" }), taskParams))!.status).toBe(
      404
    );
    expect(c.create).not.toHaveBeenCalled();
  });

  it("edits and deletes only the user's own comment", async () => {
    c.findFirst.mockResolvedValueOnce({ id: "c1" });
    const edited = (await PATCH(
      req("PATCH", { body: "updated" }),
      commentParams
    ))!;
    expect(edited.status).toBe(200);
    expect(c.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1", taskId: "t1", userId: "u1" },
      })
    );
    expect(c.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { body: "updated" },
    });

    c.findFirst.mockResolvedValueOnce(null);
    expect((await DELETE(req("DELETE"), commentParams))!.status).toBe(404);
    expect(c.delete).not.toHaveBeenCalled();

    c.findFirst.mockResolvedValueOnce({ id: "c1" });
    expect((await DELETE(req("DELETE"), commentParams))!.status).toBe(200);
    expect(c.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});
