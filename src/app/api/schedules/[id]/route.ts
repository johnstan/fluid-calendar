import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { parseScheduleBlocks, scheduleInputSchema } from "@/lib/schedules";

const LOG_SOURCE = "schedule-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** PATCH /api/schedules/:id - update name, color, default flag or blocks */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const userId = auth.userId;
    const { id } = await params;

    const parsed = scheduleInputSchema
      .partial()
      .safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid schedule", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const existing = await prisma.schedule.findFirst({ where: { id, userId } });
    if (!existing) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 }
      );
    }
    const { name, color, isDefault, blocks, sortOrder } = parsed.data;

    const schedule = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.schedule.updateMany({
          where: { userId, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.schedule.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(color !== undefined && { color }),
          ...(isDefault !== undefined && { isDefault }),
          ...(sortOrder !== undefined && { sortOrder }),
          ...(blocks !== undefined && {
            blocks: parseScheduleBlocks(blocks) as Prisma.InputJsonValue,
          }),
        },
      });
    });
    return NextResponse.json(schedule);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A schedule with this name already exists" },
        { status: 409 }
      );
    }
    logger.error(
      "Error updating schedule",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

/**
 * DELETE /api/schedules/:id - tasks on this schedule fall back to the default
 * schedule (their scheduleId is cleared by the foreign key).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const { id } = await params;

    const { count } = await prisma.schedule.deleteMany({
      where: { id, userId: auth.userId },
    });
    if (!count) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 }
      );
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logger.error(
      "Error deleting schedule",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
