-- Busy/free status of calendar events (free events do not block auto-scheduling)
ALTER TABLE "CalendarEvent" ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false;
