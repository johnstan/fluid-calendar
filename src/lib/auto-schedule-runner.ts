import { scheduleAllTasksForUser } from "@/services/scheduling/TaskSchedulingService";

import { logger } from "@/lib/logger";
import { repushDirtyBlocks } from "@/lib/task-block-push";

const LOG_SOURCE = "auto-schedule-runner";

// One Auto Schedule run per user at a time. A request that arrives while a
// run is in progress waits for it and gets its result, instead of starting a
// second run that would race it (duplicate calendar blocks, wasted work).
const runsInProgress = new Map<string, Promise<unknown>>();

// Pushing task blocks to Google Calendar is the slow part (one API call per
// moved task), so it runs after the response, chained per user so pushes
// never overlap. The app shows the new schedule straight away.
const pushChains = new Map<string, Promise<void>>();

function queueBlockPush(userId: string) {
  const previous = pushChains.get(userId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      const started = Date.now();
      await repushDirtyBlocks(userId);
      logger.info(
        "Pushed task blocks to calendar",
        { userId, ms: Date.now() - started },
        LOG_SOURCE
      );
    })
    .catch((error) => {
      logger.error(
        "Background task block push failed",
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        LOG_SOURCE
      );
    })
    .finally(() => {
      if (pushChains.get(userId) === next) pushChains.delete(userId);
    });
  pushChains.set(userId, next);
}

/**
 * Runs Auto Schedule for a user, at most one run per user at a time (a call
 * during a run joins it). Used by the API route and by background jobs
 * (e.g. after a task sync rolled a recurring task forward).
 */
export async function runAutoScheduleOnce(userId: string) {
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
    const started = Date.now();
    const tasksWithRelations = await scheduleAllTasksForUser(userId);
    logger.info(
      "Auto Schedule finished",
      { userId, ms: Date.now() - started },
      LOG_SOURCE
    );
    // Repush dirty blocks and newly scheduled tasks to calendar (background)
    queueBlockPush(userId);
    return tasksWithRelations;
  })();
  runsInProgress.set(userId, run);
  try {
    return await run;
  } finally {
    runsInProgress.delete(userId);
  }
}
