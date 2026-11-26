import { syncWindow } from "@/lib/google-calendar-sync";

jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

describe("Google sync window", () => {
  it("rolls: 3 months back to 12 months ahead, covering next January in December", () => {
    const w = syncWindow(new Date("2026-12-15T10:30:00"));
    expect(w.timeMin).toEqual(new Date("2026-09-15T00:00:00"));
    expect(w.timeMax).toEqual(new Date("2027-12-15T00:00:00"));
  });

  it("only moves once a day", () => {
    expect(syncWindow(new Date("2026-11-26T08:00:00"))).toEqual(
      syncWindow(new Date("2026-11-26T23:59:00"))
    );
  });
});
