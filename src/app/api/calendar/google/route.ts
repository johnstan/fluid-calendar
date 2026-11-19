import { NextRequest, NextResponse } from "next/server";

import { GaxiosError } from "gaxios";
import { calendar_v3, google } from "googleapis";
import { v4 as uuidv4 } from "uuid";

import { authenticateRequest } from "@/lib/auth/api-auth";
import { createAllDayDate, newDate, newDateFromYMD } from "@/lib/date-utils";
import { createGoogleOAuthClient } from "@/lib/google";
import { getGoogleCalendarClient } from "@/lib/google-calendar";
import {
  FeedNotFoundError,
  fetchAllEvents,
  processRecurrenceRule,
  syncGoogleFeed,
} from "@/lib/google-calendar-sync";
import { prisma } from "@/lib/prisma";
import { TokenManager } from "@/lib/token-manager";

const LOG_SOURCE = "GoogleCalendarAPI";

// Handle Google OAuth callback and account connection
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const codeParam = url.searchParams.get("code");

    if (!codeParam) {
      return NextResponse.json({ error: "No code provided" }, { status: 400 });
    }
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) {
      return auth.response;
    }

    const userId = auth.userId;

    const oauth2Client = await createGoogleOAuthClient({
      redirectUrl: `${process.env.NEXTAUTH_URL}/api/calendar/google`,
    });

    try {
      // Exchange code for tokens
      const code: string = codeParam;
      const tokenResponse = await oauth2Client.getToken(code);
      const tokens = tokenResponse.tokens;
      oauth2Client.setCredentials(tokens);

      // Get user info to get email
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();

      if (!userInfo.data.email) {
        return NextResponse.json(
          { error: "Could not get user email" },
          { status: 400 }
        );
      }

      // Store tokens
      const tokenManager = TokenManager.getInstance();
      const accountId = await tokenManager.storeTokens(
        "GOOGLE",
        userInfo.data.email,
        {
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token!,
          // expiry_date is an absolute epoch-ms timestamp from google-auth-library,
          // not a duration. Adding Date.now() pushed expiry decades out, so the
          // token was never refreshed and every later call 401'd.
          expiresAt: newDate(tokens.expiry_date || Date.now() + 3600 * 1000),
        },
        userId ?? "unknown"
      );

      // Get list of calendars
      const calendar = google.calendar({ version: "v3", auth: oauth2Client });
      const calendarList = await calendar.calendarList.list();

      // Store calendars
      if (calendarList.data.items) {
        for (const cal of calendarList.data.items) {
          if (cal.id && cal.summary) {
            // Check if calendar feed already exists
            const existingFeed = await prisma.calendarFeed.findFirst({
              where: {
                type: "GOOGLE",
                url: cal.id,
                accountId,
                userId,
              },
            });

            // Only create if it doesn't exist
            if (!existingFeed) {
              await prisma.calendarFeed.create({
                data: {
                  id: uuidv4(),
                  name: cal.summary,
                  url: cal.id,
                  type: "GOOGLE",
                  color: cal.backgroundColor ?? undefined,
                  accountId,
                  userId,
                },
              });
            }
          }
        }
      }

      return NextResponse.redirect(
        new URL("/settings", process.env.NEXTAUTH_URL!)
      );
    } catch (error) {
      console.error("Failed to exchange code for tokens:", error);
      return NextResponse.json(
        { error: "Failed to authenticate with Google" },
        { status: 401 }
      );
    }
  } catch (error) {
    console.error("Google Calendar OAuth error:", error);
    return NextResponse.json(
      { error: "Failed to authenticate with Google" },
      { status: 500 }
    );
  }
}

// Add a Google Calendar to sync
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) {
      return auth.response;
    }

    const userId = auth.userId;

    const { accountId, calendarId, name, color } = await request.json();

    if (!accountId || !calendarId) {
      return NextResponse.json(
        { error: "Account ID and Calendar ID are required" },
        { status: 400 }
      );
    }

    // Check if account belongs to the current user
    const account = await prisma.connectedAccount.findUnique({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Check if calendar already exists
    const existingFeed = await prisma.calendarFeed.findFirst({
      where: {
        type: "GOOGLE",
        url: calendarId,
        accountId,
        userId,
      },
    });

    if (existingFeed) {
      return NextResponse.json(existingFeed);
    }

    // Create calendar client
    const calendar = await getGoogleCalendarClient(accountId, userId);

    // Verify access to the calendar
    try {
      await calendar.calendars.get({
        calendarId,
      });
    } catch (error) {
      console.error("Failed to access calendar:", error);
      return NextResponse.json(
        { error: "Failed to access calendar" },
        { status: 403 }
      );
    }

    // Create calendar feed
    const feed = await prisma.calendarFeed.create({
      data: {
        id: uuidv4(),
        name,
        url: calendarId,
        type: "GOOGLE",
        color,
        accountId,
        userId,
      },
    });

    // Initial sync of calendar events (fetch all pages)
    const events = await fetchAllEvents(calendar, {
      calendarId,
      timeMin: newDateFromYMD(newDate().getFullYear(), 0, 1).toISOString(),
      timeMax: newDateFromYMD(newDate().getFullYear() + 1, 0, 1).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    // Store events in database
    if (events.length > 0) {
      // Prefetch master events (so we don't perform network calls inside DB transaction)
      const masterEvents = new Map<string, calendar_v3.Schema$Event>();
      for (const event of events) {
        const recId = event.recurringEventId;
        if (recId && typeof recId === "string" && !masterEvents.has(recId)) {
          try {
            const masterEvent = await calendar.events.get({
              calendarId,
              eventId: recId,
            });
            masterEvents.set(recId, masterEvent.data);
          } catch (error) {
            console.error("Failed to fetch master event:", error);
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        // Master events are prefetched before starting the transaction (to avoid network calls inside transaction)
        // `masterEvents` is available from the outer scope


        // Create or update master events
        for (const [eventId, masterEventData] of masterEvents) {
          const existingMaster = await tx.calendarEvent.findFirst({
            where: {
              feedId: feed.id,
              externalEventId: eventId,
              isMaster: true,
            },
          });

          const isAllDay = masterEventData.start
            ? !masterEventData.start.dateTime
            : false;

          const masterEventRecord = {
            feedId: feed.id,
            externalEventId: eventId,
            title: masterEventData.summary || "Untitled Event",
            description: masterEventData.description || "",
            start: isAllDay
              ? createAllDayDate(masterEventData.start?.date || "")
              : newDate(
                  masterEventData.start?.dateTime ||
                    masterEventData.start?.date ||
                    ""
                ),
            end: isAllDay
              ? createAllDayDate(masterEventData.end?.date || "")
              : newDate(
                  masterEventData.end?.dateTime ||
                    masterEventData.end?.date ||
                    ""
                ),
            location: masterEventData.location,
            isRecurring: true,
            isMaster: true,
            recurrenceRule: processRecurrenceRule(
              masterEventData.recurrence,
              newDate(
                masterEventData.start?.dateTime ||
                  masterEventData.start?.date ||
                  ""
              )
            ),
            recurringEventId: masterEventData.recurringEventId,
            allDay: isAllDay,
            status: masterEventData.status,
            sequence: masterEventData.sequence,
            created: masterEventData.created
              ? newDate(masterEventData.created)
              : undefined,
            lastModified: masterEventData.updated
              ? newDate(masterEventData.updated)
              : undefined,
            organizer: masterEventData.organizer
              ? {
                  name: masterEventData.organizer.displayName,
                  email: masterEventData.organizer.email,
                }
              : undefined,
            attendees: masterEventData.attendees?.map(
              (a: calendar_v3.Schema$EventAttendee) => ({
                name: a.displayName,
                email: a.email,
                status: a.responseStatus,
              })
            ),
          };

          if (existingMaster) {
            await tx.calendarEvent.update({
              where: { id: existingMaster.id },
              data: masterEventRecord,
            });
          } else {
            await tx.calendarEvent.create({
              data: masterEventRecord,
            });
          }
        }

        // Create or update instances
        for (const event of events) {
          const masterEvent = event.recurringEventId
            ? await tx.calendarEvent.findFirst({
                where: {
                  feedId: feed.id,
                  externalEventId: event.recurringEventId,
                  isMaster: true,
                },
              })
            : null;

          const isAllDay = event.start ? !event.start.dateTime : false;

          const eventRecord = {
            feedId: feed.id,
            externalEventId: event.id,
            title: event.summary || "Untitled Event",
            description: event.description || "",
            start: isAllDay
              ? createAllDayDate(event.start?.date || "")
              : newDate(event.start?.dateTime || event.start?.date || ""),
            end: isAllDay
              ? createAllDayDate(event.end?.date || "")
              : newDate(event.end?.dateTime || event.end?.date || ""),
            location: event.location,
            isRecurring: !!event.recurringEventId,
            isMaster: false,
            masterEventId: masterEvent?.id,
            recurringEventId: event.recurringEventId,
            recurrenceRule: masterEvent
              ? undefined
              : processRecurrenceRule(
                  event.recurrence,
                  event.start
                    ? newDate(event.start?.dateTime || event.start?.date || "")
                    : undefined
                ),
            allDay: isAllDay,
            status: event.status,
            sequence: event.sequence,
            created: event.created ? newDate(event.created) : undefined,
            lastModified: event.updated ? newDate(event.updated) : undefined,
            organizer: event.organizer
              ? {
                  name: event.organizer.displayName,
                  email: event.organizer.email,
                }
              : undefined,
            attendees: event.attendees?.map((a) => ({
              name: a.displayName,
              email: a.email,
              status: a.responseStatus,
            })),
          };

          const existingEvent = await tx.calendarEvent.findFirst({
            where: {
              feedId: feed.id,
              externalEventId: event.id,
            },
          });

          if (existingEvent) {
            await tx.calendarEvent.update({
              where: { id: existingEvent.id },
              data: eventRecord,
            });
          } else {
            await tx.calendarEvent.create({
              data: eventRecord,
            });
          }
        }
      }, {timeout: 30000});
    }

    return NextResponse.json(feed);
  } catch (error) {
    console.error("Failed to add calendar:", error);
    return NextResponse.json(
      { error: "Failed to add calendar" },
      { status: 500 }
    );
  }
}

// Sync specific calendar
export async function PUT(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request, LOG_SOURCE);
    if ("response" in auth) {
      return auth.response;
    }

    const userId = auth.userId;

    const { feedId } = await request.json();

    if (!feedId) {
      return NextResponse.json(
        { error: "Feed ID is required" },
        { status: 400 }
      );
    }

    await syncGoogleFeed(feedId, userId);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof FeedNotFoundError) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    }

    console.error("Failed to sync Google calendar:", error);

    // Check if it's an auth error
    if (error instanceof GaxiosError && Number(error.code) === 401) {
      return NextResponse.json(
        { error: "Authentication failed. Please try signing in again." },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { error: "Failed to sync calendar" },
      { status: 500 }
    );
  }
}
