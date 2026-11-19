import { syncGoogleFeed } from "@/lib/google-calendar-sync";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { TaskSyncManager } from "@/lib/task-sync/task-sync-manager";

const LOG_SOURCE = "SyncScheduler";

// Survive Next.js hot reloads / double registration
const g = globalThis as unknown as {
  __taskSyncTimer?: NodeJS.Timeout;
  __taskSyncRunning?: boolean;
  __calSyncTimer?: NodeJS.Timeout;
  __calSyncRunning?: boolean;
  __calSyncLastRun?: Map<string, number>; // userId -> epoch ms
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- Google Tasks / task lists ----------

async function runTaskSync(): Promise<void> {
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
          `Scheduled task sync failed for mapping ${mapping.id}`,
          { error: errMsg(error) },
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
      { error: errMsg(error) },
      LOG_SOURCE
    );
  } finally {
    g.__taskSyncRunning = false;
  }
}

export function startTaskSyncScheduler(intervalMinutes: number): void {
  if (g.__taskSyncTimer) return;
  const ms = Math.max(1, intervalMinutes) * 60 * 1000;
  setTimeout(runTaskSync, 30 * 1000); // first run shortly after boot
  g.__taskSyncTimer = setInterval(runTaskSync, ms);
  logger.info(
    `Task sync scheduler started (every ${intervalMinutes} min)`,
    {},
    LOG_SOURCE
  );
}

// ---------- Google Calendar feeds ----------
// Follows Settings → Integrations per user: Google Calendar enabled,
// auto-sync on, and the interval in minutes (defaults: on, 5 min).

async function runCalendarSync(): Promise<void> {
  if (g.__calSyncRunning) return;
  g.__calSyncRunning = true;
  const lastRun = (g.__calSyncLastRun ??= new Map());
  try {
    const feeds = await prisma.calendarFeed.findMany({
      where: {
        type: "GOOGLE",
        enabled: true,
        userId: { not: null },
        accountId: { not: null },
      },
      select: { id: true, name: true, userId: true },
    });
    const userIds = [...new Set(feeds.map((f) => f.userId as string))];
    const settings = await prisma.integrationSettings.findMany({
      where: { userId: { in: userIds } },
    });
    const byUser = new Map(settings.map((s) => [s.userId, s]));

    for (const userId of userIds) {
      const s = byUser.get(userId);
      const enabled = s
        ? s.googleCalendarEnabled && s.googleCalendarAutoSync
        : true;
      const intervalMin = Math.max(1, s?.googleCalendarInterval ?? 5);
      if (!enabled) continue;
      if (
        Date.now() - (lastRun.get(userId) ?? 0) <
        intervalMin * 60 * 1000 - 5000
      )
        continue;
      lastRun.set(userId, Date.now());

      for (const feed of feeds.filter((f) => f.userId === userId)) {
        try {
          await syncGoogleFeed(feed.id, userId);
        } catch (error) {
          logger.error(
            `Scheduled calendar sync failed for "${feed.name}"`,
            { feedId: feed.id, error: errMsg(error) },
            LOG_SOURCE
          );
          await prisma.calendarFeed
            .update({
              where: { id: feed.id },
              data: { error: errMsg(error).slice(0, 500) },
            })
            .catch(() => undefined);
        }
      }
    }
  } catch (error) {
    logger.error(
      "Scheduled calendar sync crashed",
      { error: errMsg(error) },
      LOG_SOURCE
    );
  } finally {
    g.__calSyncRunning = false;
  }
}

export function startCalendarSyncScheduler(): void {
  if (g.__calSyncTimer) return;
  // Check every minute which users are due, per their own interval setting
  setTimeout(runCalendarSync, 45 * 1000);
  g.__calSyncTimer = setInterval(runCalendarSync, 60 * 1000);
  logger.info(
    "Calendar sync scheduler started (interval from Settings → Integrations)",
    {},
    LOG_SOURCE
  );
}
