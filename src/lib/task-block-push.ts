import { GaxiosError } from "gaxios";

import {
  createGoogleEvent,
  deleteGoogleEvent,
  updateGoogleEvent,
} from "@/lib/google-calendar";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const LOG_SOURCE = "task-block-push";

// Description written on every pushed block; identifies events we own when
// cleaning up orphans, so the user's own events in that calendar are kept.
export const TASK_BLOCK_DESCRIPTION = "Scheduled by FluidCalendar";

// Per-task serialisation. Without it, two pushes for a task that has no event
// yet (e.g. overlapping Auto Schedule runs) both create an event and only the
// last ID is kept, leaving the other as a permanent orphan in the calendar.
const taskLocks = new Map<string, Promise<void>>();

async function withTaskLock<T>(
  taskId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = previous.then(() => current);
  taskLocks.set(taskId, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (taskLocks.get(taskId) === chained) taskLocks.delete(taskId);
  }
}

/**
 * Detects if a GaxiosError is a 404/410 (Not Found / Gone).
 */
function isGoogleEventNotFound(error: unknown): boolean {
  if (error instanceof GaxiosError) {
    const status = error.response?.status;
    return status === 404 || status === 410;
  }
  return false;
}

/** Mirror a pushed update into the local CalendarEvent copy (non-fatal). */
async function updateLocalBlockRow(
  externalEventId: string,
  data: { title: string; start: Date | null; end: Date | null }
) {
  try {
    await prisma.calendarEvent.updateMany({
      where: { externalEventId },
      data: {
        title: data.title,
        ...(data.start && { start: data.start }),
        ...(data.end && { end: data.end }),
      },
    });
  } catch (error) {
    logger.warn(
      `Could not update local copy of task block`,
      {
        externalEventId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  }
}

/** Remove the local CalendarEvent copy of a deleted block (non-fatal). */
async function deleteLocalBlockRow(externalEventId: string) {
  try {
    await prisma.calendarEvent.deleteMany({ where: { externalEventId } });
  } catch (error) {
    logger.warn(
      `Could not delete local copy of task block`,
      {
        externalEventId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  }
}

/**
 * Tasks whose pushed block no longer matches them: the task lost its slot or
 * was completed, or the event's times differ from the task's scheduled times.
 * Compares against our local copy of the push calendar; tasks whose event
 * hasn't been synced locally yet are skipped.
 */
async function findOutOfSyncBlockTaskIds(
  userId: string,
  feedId: string
): Promise<string[]> {
  // Match on the event, not on task.blockFeedId: if the push calendar was
  // removed and re-added in FluidCalendar, tasks still point at the old feed
  // id although their events live in the (same) current calendar
  const tasks = await prisma.task.findMany({
    where: { userId, blockEventId: { not: null } },
    select: {
      id: true,
      blockEventId: true,
      blockFeedId: true,
      scheduledStart: true,
      scheduledEnd: true,
      status: true,
    },
  });
  if (tasks.length === 0) return [];

  const events = await prisma.calendarEvent.findMany({
    where: {
      feedId,
      externalEventId: { in: tasks.map((t) => t.blockEventId!) },
    },
    select: { externalEventId: true, start: true, end: true },
  });
  const byId = new Map(events.map((e) => [e.externalEventId, e]));

  // Repair stale feed references for events found in the current calendar
  const staleFeed = tasks
    .filter((t) => byId.has(t.blockEventId) && t.blockFeedId !== feedId)
    .map((t) => t.id);
  if (staleFeed.length > 0) {
    await prisma.task.updateMany({
      where: { id: { in: staleFeed }, userId },
      data: { blockFeedId: feedId },
    });
    logger.info(
      `Repaired task blocks pointing at a removed calendar feed`,
      { userId, count: staleFeed.length },
      LOG_SOURCE
    );
  }

  const TOLERANCE_MS = 60 * 1000;
  const differs = (a: Date | null, b: Date) =>
    !a ||
    Math.abs(new Date(a).getTime() - new Date(b).getTime()) > TOLERANCE_MS;

  return tasks
    .filter((task) => {
      const event = byId.get(task.blockEventId);
      if (!event) return false;
      if (!task.scheduledStart || !task.scheduledEnd) return true;
      if (task.status === "completed") return true;
      return (
        differs(task.scheduledStart, event.start) ||
        differs(task.scheduledEnd, event.end)
      );
    })
    .map((task) => task.id);
}

/**
 * Pushes a task's scheduled block to Google Calendar.
 * Handles create, update, or delete of the calendar event based on current state.
 * Handles feed changes (delete from old, create on new).
 */
export async function pushTaskBlock(userId: string, taskId: string) {
  return withTaskLock(taskId, () => pushTaskBlockUnlocked(userId, taskId));
}

async function pushTaskBlockUnlocked(userId: string, taskId: string) {
  try {
    // Load task and user settings in parallel
    const [task, settings, userSettings] = await Promise.all([
      prisma.task.findUnique({
        where: { id: taskId, userId },
      }),
      prisma.autoScheduleSettings.findUnique({
        where: { userId },
      }),
      prisma.userSettings.findUnique({
        where: { userId },
      }),
    ]);
    const timeZone = userSettings?.timeZone;

    if (!task) {
      logger.warn(`Task not found for push: ${taskId}`, { userId }, LOG_SOURCE);
      return;
    }

    if (!settings) {
      logger.warn(
        `AutoScheduleSettings not found for push`,
        { userId },
        LOG_SOURCE
      );
      return;
    }

    // Determine desired state
    const shouldExist =
      settings.pushTasksToCalendar &&
      settings.pushTasksFeedId &&
      task.scheduledStart &&
      task.scheduledEnd &&
      task.status !== "completed";

    // Load the target calendar feed (new feed if changing, or current feed if updating)
    let targetFeed = null;
    let targetAccountId = null;
    let targetCalendarId = null;

    if (shouldExist) {
      targetFeed = await prisma.calendarFeed.findUnique({
        where: { id: settings.pushTasksFeedId! },
        include: { account: true },
      });

      if (!targetFeed) {
        logger.warn(
          `Target calendar feed not found: ${settings.pushTasksFeedId}`,
          { userId },
          LOG_SOURCE
        );
        if (task.blockEventId) {
          await prisma.task.update({
            where: { id: taskId },
            data: { blockDirty: true },
          });
        }
        return;
      }

      // Validate feed is GOOGLE type
      if (targetFeed.type !== "GOOGLE") {
        logger.error(
          `Feed must be GOOGLE type for task block push`,
          { feedId: targetFeed.id, feedType: targetFeed.type, userId },
          LOG_SOURCE
        );
        return;
      }

      // Validate feed has required fields
      if (!targetFeed.accountId || !targetFeed.url) {
        logger.error(
          `Feed missing accountId or URL`,
          { feedId: targetFeed.id, userId },
          LOG_SOURCE
        );
        return;
      }

      targetAccountId = targetFeed.accountId;
      targetCalendarId = targetFeed.url;
    }

    // Load the old feed (where event currently lives) if event exists
    let oldFeed = null;
    let oldAccountId = null;
    let oldCalendarId = null;

    if (task.blockEventId && task.blockFeedId) {
      oldFeed = await prisma.calendarFeed.findUnique({
        where: { id: task.blockFeedId },
        include: { account: true },
      });

      if (
        oldFeed &&
        oldFeed.type === "GOOGLE" &&
        oldFeed.accountId &&
        oldFeed.url
      ) {
        oldAccountId = oldFeed.accountId;
        oldCalendarId = oldFeed.url;
      }
    }

    // Handle state transitions
    if (shouldExist && !task.blockEventId) {
      // Create new event
      await createNewEvent(
        userId,
        taskId,
        task,
        targetAccountId!,
        targetCalendarId!,
        targetFeed!.id,
        timeZone
      );
    } else if (shouldExist && task.blockEventId && task.blockFeedId) {
      // Check if feed changed
      if (task.blockFeedId !== settings.pushTasksFeedId) {
        // Feed changed: delete from old, create on new
        await deleteEventFromFeed(
          userId,
          taskId,
          oldAccountId,
          oldCalendarId,
          task.blockEventId
        );
        await createNewEvent(
          userId,
          taskId,
          task,
          targetAccountId!,
          targetCalendarId!,
          targetFeed!.id,
          timeZone
        );
      } else {
        // Same feed: update existing event
        await updateExistingEvent(
          userId,
          taskId,
          task,
          targetAccountId!,
          targetCalendarId!,
          timeZone
        );
      }
    } else if (!shouldExist && task.blockEventId) {
      // Delete existing event
      if (oldAccountId && oldCalendarId) {
        await deleteEventFromFeed(
          userId,
          taskId,
          oldAccountId,
          oldCalendarId,
          task.blockEventId
        );
      } else {
        // Old feed info missing; clear the task state
        logger.warn(
          `Cannot delete event: old feed info missing`,
          {
            taskId,
            blockEventId: task.blockEventId,
            blockFeedId: task.blockFeedId,
          },
          LOG_SOURCE
        );
        await prisma.task.update({
          where: { id: taskId },
          data: {
            blockEventId: null,
            blockFeedId: null,
            blockDirty: false,
          },
        });
      }
    }
  } catch (error) {
    logger.error(
      `Error in pushTaskBlock`,
      {
        taskId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  }
}

/**
 * Creates a new calendar event for a task.
 */
async function createNewEvent(
  userId: string,
  taskId: string,
  task: {
    title: string;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
  },
  accountId: string,
  calendarId: string,
  feedId: string,
  timeZone?: string
) {
  try {
    logger.debug(
      `Creating calendar event for task`,
      {
        taskId,
        taskTitle: task.title,
        start: task.scheduledStart?.toISOString() || null,
        end: task.scheduledEnd?.toISOString() || null,
      },
      LOG_SOURCE
    );

    const event = await createGoogleEvent(accountId, userId, calendarId, {
      title: task.title,
      description: TASK_BLOCK_DESCRIPTION,
      start: task.scheduledStart!,
      end: task.scheduledEnd!,
      timeZone,
    });

    if (event.id) {
      await prisma.task.update({
        where: { id: taskId },
        data: {
          blockEventId: event.id,
          blockFeedId: feedId,
          blockDirty: false,
        },
      });

      logger.info(
        `Created calendar event for task`,
        { taskId, eventId: event.id, userId },
        LOG_SOURCE
      );
    }
  } catch (error) {
    logger.error(
      `Failed to create calendar event`,
      {
        taskId,
        error: error instanceof Error ? error.message : String(error),
        userId,
      },
      LOG_SOURCE
    );

    await prisma.task.update({
      where: { id: taskId },
      data: { blockDirty: true },
    });
  }
}

/**
 * Updates an existing calendar event for a task.
 * On 404/410: clears blockEventId and sets blockDirty (next push will recreate).
 */
async function updateExistingEvent(
  userId: string,
  taskId: string,
  task: {
    title: string;
    blockEventId: string | null;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
  },
  accountId: string,
  calendarId: string,
  timeZone?: string
) {
  try {
    logger.debug(
      `Updating calendar event for task`,
      {
        taskId,
        eventId: task.blockEventId || null,
        taskTitle: task.title,
        start: task.scheduledStart?.toISOString() || null,
        end: task.scheduledEnd?.toISOString() || null,
      },
      LOG_SOURCE
    );

    await updateGoogleEvent(accountId, userId, calendarId, task.blockEventId!, {
      title: task.title,
      description: TASK_BLOCK_DESCRIPTION,
      start: task.scheduledStart || undefined,
      end: task.scheduledEnd || undefined,
      mode: "single",
      timeZone,
    });

    // Keep our local copy of the event in step, so reconciliation sees the
    // new times before the next calendar sync
    await updateLocalBlockRow(task.blockEventId!, {
      title: task.title,
      start: task.scheduledStart,
      end: task.scheduledEnd,
    });

    await prisma.task.update({
      where: { id: taskId },
      data: { blockDirty: false },
    });

    logger.info(
      `Updated calendar event for task`,
      { taskId, eventId: task.blockEventId, userId },
      LOG_SOURCE
    );
  } catch (error) {
    // On 404/410: event was manually deleted in Google Calendar
    if (isGoogleEventNotFound(error)) {
      logger.info(
        `Event manually deleted in Google Calendar; will recreate on next push`,
        { taskId, eventId: task.blockEventId },
        LOG_SOURCE
      );
      // Clear event ID and set dirty so next push recreates it
      await prisma.task.update({
        where: { id: taskId },
        data: {
          blockEventId: null,
          blockDirty: true,
        },
      });
    } else {
      logger.error(
        `Failed to update calendar event`,
        {
          taskId,
          eventId: task.blockEventId,
          error: error instanceof Error ? error.message : String(error),
          userId,
        },
        LOG_SOURCE
      );

      await prisma.task.update({
        where: { id: taskId },
        data: { blockDirty: true },
      });
    }
  }
}

/**
 * Deletes a calendar event from a specific feed.
 * On 404/410: treats as success (event already gone).
 */
async function deleteEventFromFeed(
  userId: string,
  taskId: string,
  accountId: string | null,
  calendarId: string | null,
  blockEventId: string
) {
  // If feed info is missing, treat as success (can't delete, so clear local state)
  if (!accountId || !calendarId) {
    logger.debug(
      `Feed info missing for delete; clearing local event state`,
      { taskId, blockEventId },
      LOG_SOURCE
    );
    await prisma.task.update({
      where: { id: taskId },
      data: {
        blockEventId: null,
        blockFeedId: null,
        blockDirty: false,
      },
    });
    return;
  }

  try {
    logger.debug(
      `Deleting calendar event for task`,
      { taskId, eventId: blockEventId },
      LOG_SOURCE
    );

    await deleteGoogleEvent(
      accountId,
      userId,
      calendarId,
      blockEventId,
      "single"
    );
    await deleteLocalBlockRow(blockEventId);

    await prisma.task.update({
      where: { id: taskId },
      data: {
        blockEventId: null,
        blockFeedId: null,
        blockDirty: false,
      },
    });

    logger.info(
      `Deleted calendar event for task`,
      { taskId, eventId: blockEventId, userId },
      LOG_SOURCE
    );
  } catch (error) {
    // On 404/410: event was already deleted, treat as success
    if (isGoogleEventNotFound(error)) {
      logger.debug(
        `Event already deleted in Google Calendar; clearing local state`,
        { taskId, eventId: blockEventId },
        LOG_SOURCE
      );
      await prisma.task.update({
        where: { id: taskId },
        data: {
          blockEventId: null,
          blockFeedId: null,
          blockDirty: false,
        },
      });
    } else {
      logger.error(
        `Failed to delete calendar event`,
        {
          taskId,
          eventId: blockEventId,
          error: error instanceof Error ? error.message : String(error),
          userId,
        },
        LOG_SOURCE
      );

      await prisma.task.update({
        where: { id: taskId },
        data: { blockDirty: true },
      });
    }
  }
}

/**
 * Fire-and-forget wrapper for pushing a task block.
 * Calls pushTaskBlock asynchronously without blocking the caller.
 */
export function schedulePushTaskBlock(userId: string, taskId: string): void {
  pushTaskBlock(userId, taskId).catch((error) => {
    logger.error(
      `Unhandled error in schedulePushTaskBlock`,
      {
        taskId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  });
}

/**
 * Deletes a calendar event for a task that no longer exists in the database.
 * Call this AFTER deleting the task from Prisma if it had a blockEventId.
 * On 404/410: treats as success (event already gone).
 */
export async function deleteTaskBlockEvent(
  userId: string,
  blockEventId: string,
  feedId: string
) {
  try {
    logger.debug(
      `Deleting orphaned calendar event`,
      { blockEventId, feedId, userId },
      LOG_SOURCE
    );

    const feed = await prisma.calendarFeed.findUnique({
      where: { id: feedId },
      include: { account: true },
    });

    if (!feed || !feed.account) {
      logger.warn(
        `Feed not found for orphaned event deletion`,
        { feedId, userId },
        LOG_SOURCE
      );
      return;
    }

    if (feed.type !== "GOOGLE" || !feed.url) {
      logger.warn(
        `Cannot delete event from non-GOOGLE feed`,
        { feedId, feedType: feed.type, userId },
        LOG_SOURCE
      );
      return;
    }

    await deleteGoogleEvent(
      feed.accountId!,
      userId,
      feed.url,
      blockEventId,
      "single"
    );
    await deleteLocalBlockRow(blockEventId);

    logger.info(
      `Deleted orphaned calendar event`,
      { blockEventId, feedId, userId },
      LOG_SOURCE
    );
  } catch (error) {
    // On 404/410: event already deleted, treat as success
    if (isGoogleEventNotFound(error)) {
      logger.debug(
        `Orphaned event already deleted in Google Calendar`,
        { blockEventId, feedId, userId },
        LOG_SOURCE
      );
    } else {
      logger.error(
        `Failed to delete orphaned calendar event`,
        {
          blockEventId,
          feedId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        LOG_SOURCE
      );
    }
  }
}

/**
 * Removes all pushed task blocks for a user.
 * Called when push is disabled or when clearing a user's blocks.
 */
export async function removeAllTaskBlocks(userId: string) {
  try {
    logger.info(`Removing all task blocks for user`, { userId }, LOG_SOURCE);

    // Find all tasks with pushed events
    const tasksWithEvents = await prisma.task.findMany({
      where: {
        userId,
        blockEventId: { not: null },
      },
    });

    logger.debug(
      `Found tasks with pushed events`,
      { userId, count: tasksWithEvents.length },
      LOG_SOURCE
    );

    // Delete each event and clear task state
    for (const task of tasksWithEvents) {
      if (task.blockFeedId) {
        await deleteTaskBlockEvent(
          userId,
          task.blockEventId!,
          task.blockFeedId
        );
      } else {
        logger.warn(
          `Task has event but no feed ID; clearing local state only`,
          { taskId: task.id },
          LOG_SOURCE
        );
      }
      // Always clear local block state so tasks never reference deleted events
      await prisma.task.update({
        where: { id: task.id },
        data: {
          blockEventId: null,
          blockFeedId: null,
          blockDirty: false,
        },
      });
    }

    logger.info(
      `Completed removal of all task blocks`,
      { userId, count: tasksWithEvents.length },
      LOG_SOURCE
    );
  } catch (error) {
    logger.error(
      `Error in removeAllTaskBlocks`,
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  }
}

/**
 * Repushes all dirty blocks for a user and newly scheduled tasks without events.
 * Called after schedule-all completes to reconcile event state.
 * Covers: blockDirty=true (retries), newly scheduled (scheduledStart set but no event).
 */
export async function repushDirtyBlocks(userId: string) {
  try {
    logger.info(`Starting repush of dirty blocks`, { userId }, LOG_SOURCE);

    // Find tasks that need pushing:
    // 1. blockDirty=true (failed pushes, including failed deletes)
    // 2. scheduledStart/End set, status not completed, but blockEventId null (new schedules)
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        OR: [
          { blockDirty: true },
          {
            AND: [
              { scheduledStart: { not: null } },
              { scheduledEnd: { not: null } },
              { blockEventId: null },
              { status: { not: "completed" } },
            ],
          },
        ],
      },
    });

    logger.debug(
      `Found tasks for repush`,
      { userId, count: tasks.length },
      LOG_SOURCE
    );

    // Check if push is enabled
    const settings = await prisma.autoScheduleSettings.findUnique({
      where: { userId },
    });

    if (!settings?.pushTasksToCalendar) {
      logger.debug(`Push disabled, skipping repush`, { userId }, LOG_SOURCE);
      return;
    }

    // Push each task sequentially
    for (const task of tasks) {
      await pushTaskBlock(userId, task.id);
    }

    // Also fix blocks that drifted out of step with their task (e.g. moved by
    // an earlier run without being flagged), comparing against the calendar
    if (settings.pushTasksFeedId) {
      const pushed = new Set(tasks.map((t) => t.id));
      const outOfSync = (
        await findOutOfSyncBlockTaskIds(userId, settings.pushTasksFeedId)
      ).filter((id) => !pushed.has(id));
      for (const id of outOfSync) {
        await pushTaskBlock(userId, id);
      }
      if (outOfSync.length) {
        logger.info(
          `Re-pushed out-of-sync task blocks`,
          { userId, count: outOfSync.length },
          LOG_SOURCE
        );
      }
    }

    // Remove pushed blocks that no task points at any more
    await cleanupOrphanTaskBlocks(userId);

    logger.info(
      `Completed repush of dirty blocks`,
      { userId, count: tasks.length },
      LOG_SOURCE
    );
  } catch (error) {
    logger.error(
      `Error in repushDirtyBlocks`,
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_SOURCE
    );
  }
}

/**
 * Deletes events in the push calendar that were created by FluidCalendar
 * (marked with TASK_BLOCK_DESCRIPTION) but are no longer referenced by any
 * task - e.g. duplicates from overlapping pushes. Events without the marker
 * are never touched.
 */
export async function cleanupOrphanTaskBlocks(userId: string) {
  try {
    const settings = await prisma.autoScheduleSettings.findUnique({
      where: { userId },
    });
    if (!settings?.pushTasksToCalendar || !settings.pushTasksFeedId) return;

    const feed = await prisma.calendarFeed.findUnique({
      where: { id: settings.pushTasksFeedId },
    });
    if (!feed || feed.type !== "GOOGLE" || !feed.accountId || !feed.url) {
      return;
    }

    const referenced = new Set(
      (
        await prisma.task.findMany({
          where: { userId, blockEventId: { not: null } },
          select: { blockEventId: true },
        })
      ).map((t) => t.blockEventId)
    );

    const events = await prisma.calendarEvent.findMany({
      where: {
        feedId: feed.id,
        description: TASK_BLOCK_DESCRIPTION,
        externalEventId: { not: null },
      },
      select: { id: true, externalEventId: true },
    });
    const orphans = events.filter((e) => !referenced.has(e.externalEventId));
    if (orphans.length === 0) return;

    let deleted = 0;
    for (const orphan of orphans) {
      try {
        await deleteGoogleEvent(
          feed.accountId,
          userId,
          feed.url,
          orphan.externalEventId!,
          "single"
        );
      } catch (error) {
        if (!isGoogleEventNotFound(error)) {
          logger.error(
            `Failed to delete orphaned task block`,
            {
              eventId: orphan.externalEventId,
              error: error instanceof Error ? error.message : String(error),
            },
            LOG_SOURCE
          );
          continue;
        }
      }
      await prisma.calendarEvent.delete({ where: { id: orphan.id } });
      deleted++;
    }

    logger.info(
      `Removed orphaned task blocks`,
      { userId, found: orphans.length, deleted },
      LOG_SOURCE
    );
  } catch (error) {
    logger.error(
      `Error in cleanupOrphanTaskBlocks`,
      { userId, error: error instanceof Error ? error.message : String(error) },
      LOG_SOURCE
    );
  }
}
