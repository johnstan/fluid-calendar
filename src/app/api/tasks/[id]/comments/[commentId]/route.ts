import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { commentBodySchema } from "@/lib/task-comments";

const LOG_SOURCE = "task-comment-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Params = { params: Promise<{ id: string; commentId: string }> };

const findOwned = (taskId: string, commentId: string, userId: string) =>
  prisma.taskComment.findFirst({
    where: { id: commentId, taskId, userId },
    select: { id: true },
  });

/** PATCH /api/tasks/[id]/comments/[commentId]  Body: { body } */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const { id, commentId } = await params;

    const parsed = commentBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid comment" },
        { status: 400 }
      );
    }
    if (!(await findOwned(id, commentId, auth.userId))) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    const comment = await prisma.taskComment.update({
      where: { id: commentId },
      data: { body: parsed.data.body },
    });
    return NextResponse.json(comment);
  } catch (error) {
    logger.error(
      "Error editing task comment",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Failed to save comment" },
      { status: 500 }
    );
  }
}

/** DELETE /api/tasks/[id]/comments/[commentId] */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const { id, commentId } = await params;

    if (!(await findOwned(id, commentId, auth.userId))) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    await prisma.taskComment.delete({ where: { id: commentId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error(
      "Error deleting task comment",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Failed to delete comment" },
      { status: 500 }
    );
  }
}
