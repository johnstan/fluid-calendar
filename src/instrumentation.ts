// Runs once when the Next.js server starts.
// Self-hosted builds have no background worker, so start the task sync
// scheduler in-process. Set TASK_SYNC_INTERVAL_MINUTES=0 to disable.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PUBLIC_ENABLE_SAAS_FEATURES === "true") return; // SaaS uses its own jobs

  const minutes = Number(process.env.TASK_SYNC_INTERVAL_MINUTES ?? "5");
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const { startTaskSyncScheduler } = await import(
    "@/lib/task-sync/scheduler"
  );
  startTaskSyncScheduler(minutes);
}
