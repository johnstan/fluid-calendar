import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { parseScheduleBlocks, scheduleInputSchema } from "@/lib/schedules";

const LOG_SOURCE = "schedules-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GET /api/schedules - the user's schedules, with task counts */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;

    const schedules = await prisma.schedule.findMany({
      where: { userId: auth.userId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { tasks: true } } },
    });
    return NextResponse.json(schedules);
  } catch (error) {
    logger.error(
      "Error fetching schedules",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

/** POST /api/schedules - create a schedule */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const userId = auth.userId;

    const parsed = scheduleInputSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid schedule", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { name, color, isDefault, blocks, sortOrder } = parsed.data;

    const schedule = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.schedule.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.schedule.create({
        data: {
          userId,
          name,
          color: color ?? null,
          isDefault: !!isDefault,
          blocks: parseScheduleBlocks(blocks ?? {}) as Prisma.InputJsonValue,
          sortOrder: sortOrder ?? 0,
        },
      });
    });
    return NextResponse.json(schedule, { status: 201 });
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
      "Error creating schedule",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
