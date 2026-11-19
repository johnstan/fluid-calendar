import { useCallback } from "react";

import { toast } from "sonner";

import { useTaskStore } from "@/store/task";

/**
 * Auto Schedule with feedback: exposes whether a run is in progress (to
 * disable the button) and reports the outcome as a toast.
 */
export function useAutoSchedule() {
  const scheduleAllTasks = useTaskStore((s) => s.scheduleAllTasks);
  const isScheduling = useTaskStore((s) => s.isScheduling);

  const run = useCallback(async () => {
    if (useTaskStore.getState().isScheduling) return;
    try {
      await scheduleAllTasks();
      const scheduled = useTaskStore
        .getState()
        .tasks.filter((t) => t.status !== "completed" && t.scheduledStart);
      toast.success(
        `Auto Schedule finished · ${scheduled.length} tasks placed`
      );
    } catch {
      toast.error("Auto Schedule failed. Please try again.");
    }
  }, [scheduleAllTasks]);

  return { runAutoSchedule: run, isScheduling };
}
