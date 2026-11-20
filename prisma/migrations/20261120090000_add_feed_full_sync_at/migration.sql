-- When a calendar feed was last fully re-imported (Google incremental sync)
ALTER TABLE "CalendarFeed" ADD COLUMN "fullSyncAt" TIMESTAMP(3);
