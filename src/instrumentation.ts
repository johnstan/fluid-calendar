// Runs once when the Next.js server starts.
// Self-hosted builds have no background worker, so start the sync
// schedulers in-process:
//  - Google Tasks: every TASK_SYNC_INTERVAL_MINUTES (default 5, 0 = off)
//  - Google Calendar: per Settings → Integrations (auto-sync + interval);
//    set CALENDAR_SYNC=off to disable entirely
//
// The import must sit inside the NEXT_RUNTIME === "nodejs" block so webpack
// drops it from the Edge build (googleapis needs Node's http/https/net).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PUBLIC_ENABLE_SAAS_FEATURES === "true") return;

    const { startTaskSyncScheduler, startCalendarSyncScheduler } = await import(
      "./lib/task-sync/scheduler"
    );

    const minutes = Number(process.env.TASK_SYNC_INTERVAL_MINUTES ?? "5");
    if (Number.isFinite(minutes) && minutes > 0) {
      startTaskSyncScheduler(minutes);
    }

    if (!/^(off|false|0|no)$/i.test(process.env.CALENDAR_SYNC ?? "")) {
      startCalendarSyncScheduler();
    }
  }
}
