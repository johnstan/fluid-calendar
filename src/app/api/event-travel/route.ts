import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth/api-auth";
import {
  eventInstanceKey,
  eventSeriesKey,
  travelInputSchema,
} from "@/lib/event-travel";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const LOG_SOURCE = "event-travel-route";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load an event the user owns (via its calendar feed). */
async function findOwnedEvent(eventId: string, userId: string) {
  return prisma.calendarEvent.findFirst({
    where: { id: eventId, feed: { userId } },
    select: { id: true, externalEventId: true, recurringEventId: true },
  });
}

/**
 * GET /api/event-travel?eventId=...
 * Travel time for one event; a per-occurrence setting wins over the series.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;

    const eventId = request.nextUrl.searchParams.get("eventId");
    if (!eventId) {
      return NextResponse.json({ error: "eventId required" }, { status: 400 });
    }
    const event = await findOwnedEvent(eventId, auth.userId);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const instanceKey = eventInstanceKey(event);
    const seriesKey = eventSeriesKey(event);
    const rows = await prisma.eventTravelTime.findMany({
      where: {
        userId: auth.userId,
        eventKey: { in: seriesKey ? [instanceKey, seriesKey] : [instanceKey] },
      },
    });
    const own = rows.find((r) => r.eventKey === instanceKey);
    const series = seriesKey
      ? rows.find((r) => r.eventKey === seriesKey)
      : null;
    const row = own ?? series;

    return NextResponse.json({
      beforeMinutes: row?.beforeMinutes ?? 0,
      afterMinutes: row?.afterMinutes ?? 0,
      allOccurrences: !own && !!series,
      isRecurring: !!seriesKey,
    });
  } catch (error) {
    logger.error(
      "Error fetching event travel time",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

/**
 * PUT /api/event-travel
 * Body: { eventId, beforeMinutes, afterMinutes, allOccurrences? }
 * Zero before and after removes the setting.
 */
export async function PUT(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) return auth.response;

    const parsed = travelInputSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid travel time", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { eventId, beforeMinutes, afterMinutes, allOccurrences } =
      parsed.data;

    const event = await findOwnedEvent(eventId, auth.userId);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const instanceKey = eventInstanceKey(event);
    const seriesKey = eventSeriesKey(event);
    const targetKey = allOccurrences && seriesKey ? seriesKey : instanceKey;
    const userId = auth.userId;

    await prisma.$transaction(async (tx) => {
      // Applying to the series clears this occurrence's own override;
      // the reverse leaves the series setting alone.
      if (targetKey !== instanceKey) {
        await tx.eventTravelTime.deleteMany({
          where: { userId, eventKey: instanceKey },
        });
      }
      if (beforeMinutes === 0 && afterMinutes === 0) {
        // Keep an explicit 0/0 override if the series has travel time,
        // otherwise this occurrence would silently fall back to it.
        const seriesHasTravel =
          targetKey === instanceKey && seriesKey
            ? await tx.eventTravelTime.findUnique({
                where: { userId_eventKey: { userId, eventKey: seriesKey } },
              })
            : null;
        if (!seriesHasTravel) {
          await tx.eventTravelTime.deleteMany({
            where: { userId, eventKey: targetKey },
          });
          return;
        }
      }
      await tx.eventTravelTime.upsert({
        where: { userId_eventKey: { userId, eventKey: targetKey } },
        create: { userId, eventKey: targetKey, beforeMinutes, afterMinutes },
        update: { beforeMinutes, afterMinutes },
      });
    });

    return NextResponse.json({
      beforeMinutes,
      afterMinutes,
      allOccurrences: targetKey !== instanceKey,
      isRecurring: !!seriesKey,
    });
  } catch (error) {
    logger.error(
      "Error saving event travel time",
      { error: errMsg(error) },
      LOG_SOURCE
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
