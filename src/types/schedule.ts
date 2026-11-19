import type { ScheduleBlocks } from "@/lib/schedules";

export interface Schedule {
  id: string;
  name: string;
  color?: string | null;
  isDefault: boolean;
  blocks: ScheduleBlocks;
  sortOrder: number;
  _count?: { tasks: number };
}

export type ScheduleInput = Partial<
  Pick<Schedule, "name" | "color" | "isDefault" | "blocks" | "sortOrder">
>;
