import { create } from "zustand";

import { Schedule, ScheduleInput } from "@/types/schedule";

interface ScheduleState {
  schedules: Schedule[];
  loaded: boolean;
  fetchSchedules: () => Promise<void>;
  createSchedule: (input: ScheduleInput) => Promise<Schedule>;
  updateSchedule: (id: string, input: ScheduleInput) => Promise<Schedule>;
  deleteSchedule: (id: string) => Promise<void>;
}

async function readError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {
    // not JSON
  }
  throw new Error(message);
}

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  schedules: [],
  loaded: false,

  fetchSchedules: async () => {
    const res = await fetch("/api/schedules");
    if (!res.ok) return readError(res, "Failed to load schedules");
    set({ schedules: await res.json(), loaded: true });
  },

  createSchedule: async (input) => {
    const res = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return readError(res, "Failed to create schedule");
    const schedule: Schedule = await res.json();
    await get().fetchSchedules();
    return schedule;
  },

  updateSchedule: async (id, input) => {
    const res = await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return readError(res, "Failed to save schedule");
    const schedule: Schedule = await res.json();
    await get().fetchSchedules();
    return schedule;
  },

  deleteSchedule: async (id) => {
    const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!res.ok) return readError(res, "Failed to delete schedule");
    await get().fetchSchedules();
  },
}));
