import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { getGoogleCalendarClient } from "@/lib/google-calendar";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const LOG_SOURCE = "event-availability-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const inputSchema = z.object({
  eventId: z.string().min(1),
  isFree: z.boolean(),
  allOccurrences: z.boolean().optional().default(false),
});

/**
 * PUT /api/event-availability
 * Body: { eventId, isFree, allOccurrences? }
 * Sets an event's busy/free status in its calendar (Google) or locally
 * (Fluid's own calendars), then updates the stored rows. Free events
 * don't block auto-scheduling.
 */
export async function PUT(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;
    const userId = auth.userId;

    const parsed = inputSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { eventId, isFree, allOccurrences } = parsed.data;

    const event = await prisma.calendarEvent.findFirst({
      where: { id: eventId, feed: { userId } },
      include: { feed: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const series = allOccurrences && event.recurringEventId;
    const { feed } = event;

    if (feed.type === "GOOGLE") {
      if (!feed.accountId || !feed.url || !event.externalEventId) {
        return NextResponse.json(
          { error: "Event is not linked to Google Calendar" },
          { status: 400 }
        );
      }
      const calendar = await getGoogleCalendarClient(feed.accountId, userId);
      await calendar.events.patch({
        calendarId: feed.url,
        eventId: series ? event.recurringEventId! : event.externalEventId,
        requestBody: { transparency: isFree ? "transparent" : "opaque" },
      });
    } else if (feed.type !== "LOCAL") {
      return NextResponse.json(
        {
          error: `Changing busy/free isn't supported for ${feed.type} calendars yet`,
        },
        { status: 400 }
      );
    }

    // Mirror locally right away (the next sync confirms it)
    const updated = await prisma.calendarEvent.updateMany({
      where: series
        ? {
            feedId: feed.id,
            OR: [
              { recurringEventId: event.recurringEventId },
              { externalEventId: event.recurringEventId },
            ],
          }
        : { id: event.id },
      data: { isFree },
    });

    logger.info(
      "Updated event busy/free",
      { eventId, isFree, series: !!series, rows: updated.count },
      LOG_SOURCE
    );

    return NextResponse.json({ isFree, updated: updated.count });
  } catch (error) {
    logger.error(
      "Error updating event busy/free",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return NextResponse.json(
      { error: "Couldn't update busy/free" },
      { status: 500 }
    );
  }
}
