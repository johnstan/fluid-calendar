import {
  TASK_BLOCK_DESCRIPTION,
  buildTaskBlockDescription,
} from "@/lib/task-block-push";

jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("@/lib/google-calendar", () => ({}));

describe("buildTaskBlockDescription", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_APP_URL: "https://fluid.widomus.com/",
    };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("includes the description, details and link, with the marker last", () => {
    const text = buildTaskBlockDescription(
      {
        description: "- [ ] shred papers\n- [ ] scan photos",
        priority: "high",
        dueDate: new Date("2026-11-27T00:00:00.000Z"),
        duration: 60,
        project: { name: "Personal" },
      },
      "Europe/Amsterdam"
    );
    expect(text).toBe(
      [
        "- [ ] shred papers\n- [ ] scan photos",
        "Priority: High · Due: Fri 27 Nov · 60 min · Project: Personal",
        "Open in FluidCalendar: https://fluid.widomus.com/tasks",
        TASK_BLOCK_DESCRIPTION,
      ].join("\n\n")
    );
    expect(text.endsWith(TASK_BLOCK_DESCRIPTION)).toBe(true);
  });

  it("leaves out what a task doesn't have", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXTAUTH_URL;
    expect(buildTaskBlockDescription({ description: "  " })).toBe(
      TASK_BLOCK_DESCRIPTION
    );
    expect(buildTaskBlockDescription({ duration: 15, priority: "none" })).toBe(
      `15 min\n\n${TASK_BLOCK_DESCRIPTION}`
    );
  });
});
