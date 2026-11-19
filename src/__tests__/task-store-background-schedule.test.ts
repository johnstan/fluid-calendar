import { useTaskStore } from "@/store/task";

describe("background auto-schedule after task changes", () => {
  let resolveRun: (() => void) | null = null;
  let runs = 0;

  beforeEach(() => {
    jest.useFakeTimers();
    runs = 0;
    resolveRun = null;
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("/api/tasks/schedule-all")) {
        runs++;
        await new Promise<void>((r) => (resolveRun = r));
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => jest.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("coalesces a burst of changes into one run", async () => {
    const { queueBackgroundSchedule } = useTaskStore.getState();
    queueBackgroundSchedule();
    queueBackgroundSchedule();
    queueBackgroundSchedule();
    expect(runs).toBe(0);
    jest.advanceTimersByTime(1500);
    await flush();
    expect(runs).toBe(1);
    expect(useTaskStore.getState().isScheduling).toBe(true);
    resolveRun!();
    await flush();
    expect(useTaskStore.getState().isScheduling).toBe(false);
    expect(useTaskStore.getState().loading).toBe(false);
  });

  it("runs again after an in-flight run when a change arrives meanwhile", async () => {
    const { queueBackgroundSchedule } = useTaskStore.getState();
    queueBackgroundSchedule();
    jest.advanceTimersByTime(1500);
    await flush();
    expect(runs).toBe(1);

    queueBackgroundSchedule(); // change made while run 1 is in progress
    jest.advanceTimersByTime(1500);
    await flush();
    expect(runs).toBe(1); // waits for run 1

    resolveRun!();
    await flush();
    jest.advanceTimersByTime(1500);
    await flush();
    expect(runs).toBe(2);
    resolveRun!();
    await flush();
  });
});
