/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { PUT } from "@/app/api/event-availability/route";

import { getGoogleCalendarClient } from "@/lib/google-calendar";
import { prisma } from "@/lib/prisma";

jest.mock("@/lib/auth/api-auth", () => ({
  authenticateRequest: jest.fn(async () => ({ userId: "user-1" })),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("@/lib/google-calendar", () => ({
  getGoogleCalendarClient: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  prisma: {
    calendarEvent: { findFirst: jest.fn(), updateMany: jest.fn() },
  },
}));

const mockFind = prisma.calendarEvent.findFirst as jest.Mock;
const mockUpdateMany = prisma.calendarEvent.updateMany as jest.Mock;
const patch = jest.fn();
(getGoogleCalendarClient as jest.Mock).mockResolvedValue({
  events: { patch },
});

const put = (body: Record<string, unknown>) =>
  PUT(
    new NextRequest("http://localhost/api/event-availability", {
      method: "PUT",
      body: JSON.stringify(body),
    })
  ).then((res) => res!);

const googleEvent = {
  id: "ev-1",
  externalEventId: "g_20261120",
  recurringEventId: "g",
  feed: { id: "feed-1", type: "GOOGLE", accountId: "acc", url: "cal@x" },
};

describe("PUT /api/event-availability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks one Google occurrence free", async () => {
    mockFind.mockResolvedValue(googleEvent);
    const res = await put({ eventId: "ev-1", isFree: true });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledWith({
      calendarId: "cal@x",
      eventId: "g_20261120",
      requestBody: { transparency: "transparent" },
    });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ev-1" },
      data: { isFree: true },
    });
  });

  it("marks a whole Google series busy", async () => {
    mockFind.mockResolvedValue(googleEvent);
    await put({ eventId: "ev-1", isFree: false, allOccurrences: true });
    expect(patch.mock.calls[0][0]).toMatchObject({
      eventId: "g",
      requestBody: { transparency: "opaque" },
    });
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      feedId: "feed-1",
      OR: [{ recurringEventId: "g" }, { externalEventId: "g" }],
    });
  });

  it("updates Fluid's own calendars locally and refuses other providers", async () => {
    mockFind.mockResolvedValue({
      ...googleEvent,
      feed: { id: "f2", type: "LOCAL" },
    });
    expect((await put({ eventId: "ev-1", isFree: true })).status).toBe(200);
    expect(patch).not.toHaveBeenCalled();

    mockFind.mockResolvedValue({
      ...googleEvent,
      feed: { id: "f3", type: "OUTLOOK" },
    });
    expect((await put({ eventId: "ev-1", isFree: true })).status).toBe(400);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("404s for events on other users' calendars", async () => {
    mockFind.mockResolvedValue(null);
    expect((await put({ eventId: "x", isFree: true })).status).toBe(404);
  });
});
