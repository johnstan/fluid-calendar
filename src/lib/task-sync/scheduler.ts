import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { TaskSyncManager } from "@/lib/task-sync/task-sync-manager";

const LOG_SOURCE = "TaskSyncScheduler";

// Survive Next.js hot reloads / double registration
const g = globalThis as unknown as {
  __taskSyncTimer?: NodeJS.Timeout;
  __taskSyncRunning?: boolean;
};

async function runOnce(): Promise<void> {
  if (g.__taskSyncRunning) return; // previous run still busy
  g.__taskSyncRunning = true;
  const started = Date.now();
  try {
    const mappings = await prisma.taskListMapping.findMany({
      where: {
        syncEnabled: true,
        provider: { enabled: true, syncEnabled: true },
      },
      include: { provider: true },
    });

    const manager = new TaskSyncManager();
    let imported = 0;
    let updated = 0;
    let deleted = 0;
    let failed = 0;

    for (const mapping of mappings) {
      try {
        const r = await manager.syncTaskList(mapping);
        imported += r.imported;
        updated += r.updated;
        deleted += r.deleted;
      } catch (error) {
        failed++;
        logger.error(
          `Scheduled sync failed for mapping ${mapping.id}`,
          { error: error instanceof Error ? error.message : String(error) },
          LOG_SOURCE
        );
      }
    }

    if (imported || updated || deleted || failed) {
      logger.info(
        "Scheduled task sync finished",
        {
          mappings: mappings.length,
          imported,
          updated,
          deleted,
          failed,
          ms: Date.now() - started,
        },
        LOG_SOURCE
      );
    }
  } catch (error) {
    logger.error(
      "Scheduled task sync crashed",
      { error: error instanceof Error ? error.message : String(error) },
      LOG_SOURCE
    );
  } finally {
    g.__taskSyncRunning = false;
  }
}

export function startTaskSyncScheduler(intervalMinutes: number): void {
  if (g.__taskSyncTimer) return;
  const ms = Math.max(1, intervalMinutes) * 60 * 1000;
  // First run shortly after boot, then on the interval
  setTimeout(runOnce, 30 * 1000);
  g.__taskSyncTimer = setInterval(runOnce, ms);
  logger.info(
    `Task sync scheduler started (every ${intervalMinutes} min)`,
    {},
    LOG_SOURCE
  );
}
