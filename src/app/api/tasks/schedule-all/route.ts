import { NextRequest, NextResponse } from "next/server";

import { scheduleAllTasksForUser } from "@/services/scheduling/TaskSchedulingService";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { logger } from "@/lib/logger";
import { repushDirtyBlocks } from "@/lib/task-block-push";

const LOG_SOURCE = "task-schedule-route";

// One Auto Schedule run per user at a time. A request that arrives while a
// run is in progress waits for it and gets its result, instead of starting a
// second run that would race it (duplicate calendar blocks, wasted work).
const runsInProgress = new Map<string, Promise<unknown>>();

async function runOnce(userId: string) {
  const running = runsInProgress.get(userId);
  if (running) {
    logger.info(
      "Auto Schedule already running for user; joining it",
      { userId },
      LOG_SOURCE
    );
    return running;
  }
  const run = (async () => {
    const tasksWithRelations = await scheduleAllTasksForUser(userId);
    // Repush dirty blocks and newly scheduled tasks to calendar
    await repushDirtyBlocks(userId);
    return tasksWithRelations;
  })();
  runsInProgress.set(userId, run);
  try {
    return await run;
  } finally {
    runsInProgress.delete(userId);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) {
      return auth.response;
    }

    const userId = auth.userId;

    const tasksWithRelations = await runOnce(userId);

    return NextResponse.json(tasksWithRelations);
  } catch (error) {
    logger.error(
      "Error scheduling tasks:",
      {
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Failed to schedule tasks" },
      { status: 500 }
    );
  }
}
