// Runs once when the Next.js server starts.
// Self-hosted builds have no background worker, so start the task sync
// scheduler in-process. Set TASK_SYNC_INTERVAL_MINUTES=0 to disable.
//
// The import must sit inside the NEXT_RUNTIME === "nodejs" block so webpack
// drops it from the Edge build (googleapis needs Node's http/https/net).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const minutes = Number(process.env.TASK_SYNC_INTERVAL_MINUTES ?? "5");
    const saas = process.env.NEXT_PUBLIC_ENABLE_SAAS_FEATURES === "true";
    if (!saas && Number.isFinite(minutes) && minutes > 0) {
      const { startTaskSyncScheduler } = await import(
        "./lib/task-sync/scheduler"
      );
      startTaskSyncScheduler(minutes);
    }
  }
}
