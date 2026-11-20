import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { commentBodySchema } from "@/lib/task-comments";

const LOG_SOURCE = "task-comments-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ownsTask = (taskId: string, userId: string) =>
  prisma.task.findFirst({
    where: { id: taskId, userId },
    select: { id: true },
  });

/** GET /api/tasks/[id]/comments: the task's comments, oldest first */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const { id } = await params;

    if (!(await ownsTask(id, auth.userId))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    const comments = await prisma.taskComment.findMany({
      where: { taskId: id, userId: auth.userId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(comments);
  } catch (error) {
    logger.error(
      "Error listing task comments",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Failed to load comments" },
      { status: 500 }
    );
  }
}

/** POST /api/tasks/[id]/comments  Body: { body } */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const { id } = await params;

    const parsed = commentBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid comment" },
        { status: 400 }
      );
    }
    if (!(await ownsTask(id, auth.userId))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    const comment = await prisma.taskComment.create({
      data: { taskId: id, userId: auth.userId, body: parsed.data.body },
    });
    return NextResponse.json(comment, { status: 201 });
  } catch (error) {
    logger.error(
      "Error adding task comment",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Failed to add comment" },
      { status: 500 }
    );
  }
}
