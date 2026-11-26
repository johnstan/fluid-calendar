import { useCalendarStore } from "@/store/calendar";

jest.mock("@/store/task", () => ({
  useTaskStore: {
    getState: () => ({ queueBackgroundSchedule: jest.fn() }),
  },
}));

const feed = { id: "f1", name: "Me", type: "GOOGLE", enabled: true };
const ev = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  feedId: "f1",
  title: id,
  start: "2026-11-26T09:00:00.000Z",
  end: "2026-11-26T10:00:00.000Z",
  ...extra,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const json = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe("removing an event", () => {
  afterEach(() => jest.restoreAllMocks());

  it("disappears at once, and a slower older load can't bring it back", async () => {
    const all = [
      ev("standup-mon", { recurringEventId: "standup" }),
      ev("standup-tue", { recurringEventId: "standup" }),
      ev("lunch"),
    ];
    useCalendarStore.setState({ feeds: [feed] as never, events: all as never });

    // A load that started before the delete (e.g. on window focus) and is slow
    const staleEvents = deferred<Response>();
    const after = all.filter((e) => e.id !== "standup-tue");
    let eventsCalls = 0;
    jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "/api/feeds") return json([feed]);
      if (String(url).startsWith("/api/events")) {
        eventsCalls++;
        return eventsCalls === 1 ? staleEvents.promise : json(after);
      }
      if (init?.method === "DELETE") return json({ ok: true });
      throw new Error(`unexpected ${url}`);
    });

    const stale = useCalendarStore.getState().loadFromDatabase();
    await new Promise((r) => setTimeout(r, 0));

    const removing = useCalendarStore
      .getState()
      .removeEvent("standup-tue", "single");
    // Gone before any server round trip finishes
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual([
      "standup-mon",
      "lunch",
    ]);
    await removing;

    // The old response finally arrives, still containing the deleted event
    staleEvents.resolve(json(all));
    await stale;
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual([
      "standup-mon",
      "lunch",
    ]);
  });

  it("takes the whole series off for 'all events'", async () => {
    useCalendarStore.setState({
      feeds: [feed] as never,
      events: [
        ev("standup-mon", { recurringEventId: "standup" }),
        ev("standup-tue", { recurringEventId: "standup" }),
        ev("lunch"),
      ] as never,
    });
    const pending = deferred<Response>();
    jest.spyOn(global, "fetch").mockImplementation(async () => pending.promise);

    void useCalendarStore.getState().removeEvent("standup-mon", "series");
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual([
      "lunch",
    ]);
  });
});
