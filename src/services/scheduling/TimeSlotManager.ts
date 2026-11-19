import { AutoScheduleSettings } from "@prisma/client";
import { Task } from "@prisma/client";

import { parseSelectedCalendars, parseWorkDays } from "@/lib/autoSchedule";
import {
  addDays,
  addMinutes,
  areIntervalsOverlapping,
  differenceInHours,
  fromZonedTime,
  getDay,
  newDate,
  roundDateUp,
  setHours,
  setMinutes,
  toZonedTime,
} from "@/lib/date-utils";
import { prisma } from "@/lib/prisma";
import {
  ScheduleBlocks,
  ScheduleLike,
  parseScheduleBlocks,
  toMinutes,
} from "@/lib/schedules";

import { useSettingsStore } from "@/store/settings";

import { Conflict, TimeSlot } from "@/types/scheduling";

import { CalendarService } from "./CalendarService";
import { SlotScorer } from "./SlotScorer";

// Import the global Prisma instance

const DEFAULT_TASK_DURATION = 30;
// Candidate start times inside a schedule block are this far apart
const SCHEDULE_SLOT_STEP_MINUTES = 15;

export interface TimeSlotManager {
  findAvailableSlots(
    task: Task,
    startDate: Date,
    endDate: Date,
    userId: string
  ): Promise<TimeSlot[]>;

  isSlotAvailable(slot: TimeSlot, userId: string): Promise<boolean>;

  calculateBufferTimes(slot: TimeSlot): {
    beforeBuffer: TimeSlot;
    afterBuffer: TimeSlot;
  };

  updateScheduledTasks(userId: string): Promise<void>;

  addScheduledTaskConflict(task: Task): Promise<void>;
}

export class TimeSlotManagerImpl implements TimeSlotManager {
  private slotScorer: SlotScorer;
  private timeZone: string;

  // Named schedules (Motion-style) by id, plus the user's default one
  private schedules = new Map<string, ScheduleBlocks>();
  private defaultScheduleId: string | null = null;

  constructor(
    private settings: AutoScheduleSettings,
    private calendarService: CalendarService,
    timeZone?: string,
    schedules: ScheduleLike[] = []
  ) {
    for (const s of schedules) {
      this.schedules.set(s.id, parseScheduleBlocks(s.blocks));
      if (s.isDefault) this.defaultScheduleId = s.id;
    }
    // On the server the settings store holds no user state, so callers
    // should pass the user's timezone explicitly (e.g. from UserSettings).
    this.timeZone = timeZone || useSettingsStore.getState().user.timeZone;
    this.slotScorer = new SlotScorer(settings, new Map(), this.timeZone);
  }

  async updateScheduledTasks(userId: string): Promise<void> {
    // Fetch all scheduled tasks
    const scheduledTasks = await prisma.task.findMany({
      where: {
        isAutoScheduled: true,
        scheduledStart: { not: null },
        scheduledEnd: { not: null },
        // Locked tasks keep their slots across runs, so they must count as
        // busy no matter what project they belong to (or none at all);
        // unlocked tasks are about to be rescheduled and must not block
        scheduleLocked: true,
        userId,
      },
    });

    // Update the slot scorer with the latest scheduled tasks
    this.slotScorer.updateScheduledTasks(scheduledTasks);
  }

  async findAvailableSlots(
    task: Task,
    startDate: Date,
    endDate: Date,
    userId: string
  ): Promise<TimeSlot[]> {
    // Only load scheduled tasks from the database on the first call
    // For subsequent calls, we'll use the in-memory scheduled tasks
    // that have been updated by addScheduledTaskConflict
    if (this.slotScorer.getScheduledTasks().size === 0) {
      await this.updateScheduledTasks(userId);
    }

    // If task has a startDate that is beyond our endDate window, return empty slots
    // These tasks will get picked up in a future scheduling run
    if (task.startDate instanceof Date && task.startDate > endDate) {
      // Skip this task - it will be scheduled in a future run
      return [];
    }

    // If task has a startDate and it's after the provided startDate but within window, use the task's startDate
    const effectiveStartDate =
      task.startDate instanceof Date && task.startDate > startDate
        ? task.startDate
        : startDate;

    // 1+2. Generate candidate slots: inside the task's schedule if it has one
    // (or the user's default schedule), otherwise within global work hours
    const schedule = this.resolveSchedule(task);
    const workHourSlots = schedule
      ? this.generateScheduleSlots(
          task.duration || DEFAULT_TASK_DURATION,
          effectiveStartDate,
          endDate,
          schedule
        )
      : this.filterByWorkHours(
          this.generatePotentialSlots(
            task.duration || DEFAULT_TASK_DURATION,
            effectiveStartDate,
            endDate
          )
        );

    // 3. Check calendar conflicts
    const availableSlots = await this.removeConflicts(workHourSlots, task);

    // 4. Apply buffer times
    const slotsWithBuffer = await this.applyBufferTimes(availableSlots, task);

    // 5. Score slots
    const scoredSlots = this.scoreSlots(slotsWithBuffer, task);

    // 6. Sort by score
    const sortedSlots = this.sortByScore(scoredSlots);

    return sortedSlots;
  }

  async isSlotAvailable(slot: TimeSlot, userId: string): Promise<boolean> {
    // Check if the slot is within work hours
    if (!this.isWithinWorkHours(slot)) {
      return false;
    }

    // Check for calendar conflicts
    const conflicts = await this.findCalendarConflicts(slot, userId);
    if (conflicts.length > 0) {
      return false;
    }

    // Check for conflicts with in-memory scheduled tasks
    if (this.hasInMemoryConflict(slot)) {
      return false;
    }

    return true;
  }

  calculateBufferTimes(slot: TimeSlot): {
    beforeBuffer: TimeSlot;
    afterBuffer: TimeSlot;
  } {
    const bufferMinutes = this.settings.bufferMinutes;

    return {
      beforeBuffer: {
        start: addMinutes(slot.start, -bufferMinutes),
        end: slot.start,
        score: 0,
        conflicts: [],
        energyLevel: null,
        isWithinWorkHours: this.isWithinWorkHours({
          start: addMinutes(slot.start, -bufferMinutes),
          end: slot.start,
          score: 0,
          conflicts: [],
          energyLevel: null,
          isWithinWorkHours: false,
          hasBufferTime: false,
        }),
        hasBufferTime: false,
      },
      afterBuffer: {
        start: slot.end,
        end: addMinutes(slot.end, bufferMinutes),
        score: 0,
        conflicts: [],
        energyLevel: null,
        isWithinWorkHours: this.isWithinWorkHours({
          start: slot.end,
          end: addMinutes(slot.end, bufferMinutes),
          score: 0,
          conflicts: [],
          energyLevel: null,
          isWithinWorkHours: false,
          hasBufferTime: false,
        }),
        hasBufferTime: false,
      },
    };
  }

  /**
   * Generates potential time slots for task scheduling.
   *
   * For the first day (today):
   * 1. Starts at the later of:
   *    - Current time + minimum buffer (15 min), rounded up to next 30-min interval
   *    - Work hours start time
   * 2. If the calculated start time is past work hours, moves to next day
   *
   * For future days:
   * - Starts at work hours start time
   *
   * All days:
   * - Generates slots at 30-minute intervals
   * - Each slot has the specified duration
   * - Continues until reaching the end date
   *
   * @param duration - Duration of the task in minutes
   * @param startDate - UTC date to start generating slots from
   * @param endDate - UTC date to stop generating slots at
   * @returns Array of potential time slots
   */
  private generatePotentialSlots(
    duration: number,
    startDate: Date,
    endDate: Date
  ): TimeSlot[] {
    const slots: TimeSlot[] = [];
    const MINIMUM_BUFFER_MINUTES = 15;

    // Convert start and end dates to local time zone
    const localStartDate = toZonedTime(startDate, this.timeZone);
    let localEndDate = toZonedTime(endDate, this.timeZone);
    const localNow = toZonedTime(newDate(), this.timeZone);

    // For the first day, start at the later of:
    // 1. Current time + buffer
    // 2. Work hours start
    let localCurrentStart = localStartDate;

    // If it's today, handle current time
    if (localStartDate.toDateString() === localNow.toDateString()) {
      //question: should we check buffer using the start or the end?
      // Add minimum buffer to current time
      localCurrentStart = addMinutes(localCurrentStart, MINIMUM_BUFFER_MINUTES);

      // If this pushes us past work hours, move to next day at work start
      if (localCurrentStart.getHours() >= this.settings.workHourEnd) {
        localCurrentStart = addDays(
          setMinutes(
            setHours(localCurrentStart, this.settings.workHourStart),
            0
          ),
          1
        );
      }
    } else {
      // For future days, start exactly at work hours start time
      localCurrentStart = setMinutes(
        setHours(localCurrentStart, this.settings.workHourStart),
        0
      );
    }

    localCurrentStart = roundDateUp(localCurrentStart);
    localEndDate = roundDateUp(localEndDate);
    // Generate slots advancing by task duration
    while (localCurrentStart < localEndDate) {
      const slotEnd = addMinutes(localCurrentStart, duration);
      // localCurrentStart/slotEnd hold wall-clock values in the user's
      // timezone; convert back to real UTC instants before storing
      const slot: TimeSlot = {
        start: fromZonedTime(localCurrentStart, this.timeZone),
        end: fromZonedTime(slotEnd, this.timeZone),
        score: 0,
        conflicts: [],
        energyLevel: null,
        isWithinWorkHours: false,
        hasBufferTime: false,
      };

      slots.push(slot);
      localCurrentStart = addMinutes(localCurrentStart, duration);
    }

    return slots;
  }

  /** The task's own schedule, else the default schedule, else none. */
  private resolveSchedule(
    task: Task & { scheduleId?: string | null }
  ): ScheduleBlocks | null {
    if (task.scheduleId && this.schedules.has(task.scheduleId)) {
      return this.schedules.get(task.scheduleId)!;
    }
    if (this.defaultScheduleId) {
      return this.schedules.get(this.defaultScheduleId) ?? null;
    }
    return null;
  }

  /**
   * Candidate slots that fit entirely inside a schedule's blocks, between
   * startDate and endDate. Blocks are wall-clock times in the user's timezone.
   */
  private generateScheduleSlots(
    duration: number,
    startDate: Date,
    endDate: Date,
    blocks: ScheduleBlocks
  ): TimeSlot[] {
    const slots: TimeSlot[] = [];
    // Never start sooner than 15 minutes from now (same rule as work hours)
    const earliest = new Date(
      Math.max(startDate.getTime(), addMinutes(newDate(), 15).getTime())
    );
    const localStart = toZonedTime(earliest, this.timeZone);
    const localEnd = toZonedTime(endDate, this.timeZone);

    // Walk day by day in local wall-clock time
    let day = setMinutes(setHours(localStart, 0), 0);
    day.setSeconds(0, 0);
    while (day <= localEnd) {
      for (const block of blocks[String(day.getDay())] ?? []) {
        const blockEnd = toMinutes(block.end);
        for (
          let m = toMinutes(block.start);
          m + duration <= blockEnd;
          m += SCHEDULE_SLOT_STEP_MINUTES
        ) {
          const localSlotStart = addMinutes(day, m);
          const start = fromZonedTime(localSlotStart, this.timeZone);
          if (start < earliest || start >= endDate) continue;
          slots.push({
            start,
            end: fromZonedTime(
              addMinutes(localSlotStart, duration),
              this.timeZone
            ),
            score: 0,
            conflicts: [],
            energyLevel: null,
            isWithinWorkHours: true,
            hasBufferTime: false,
          });
        }
      }
      day = addDays(day, 1);
    }
    return slots;
  }

  private filterByWorkHours(slots: TimeSlot[]): TimeSlot[] {
    const filteredSlots = slots.filter((slot) => {
      // Convert UTC to local time for comparison
      const localStart = toZonedTime(slot.start, this.timeZone);
      const localEnd = toZonedTime(slot.end, this.timeZone);

      const startHour = localStart.getHours();
      const endHour = localEnd.getHours();
      const dayOfWeek = localStart.getDay();

      const workDays = parseWorkDays(this.settings.workDays);
      const isWorkDay = workDays.includes(dayOfWeek);
      const isWithinWorkHours =
        startHour >= this.settings.workHourStart &&
        endHour <= this.settings.workHourEnd &&
        startHour < this.settings.workHourEnd; // Ensure start is before work hours end
      const result = isWorkDay && isWithinWorkHours;
      if (result) {
        slot.isWithinWorkHours = true;
      }
      return result;
    });

    return filteredSlots;
  }

  private isWithinWorkHours(slot: TimeSlot): boolean {
    const localStart = toZonedTime(slot.start, this.timeZone);
    const localEnd = toZonedTime(slot.end, this.timeZone);

    const workDays = parseWorkDays(this.settings.workDays);
    const slotDay = getDay(localStart);

    if (!workDays.includes(slotDay)) {
      return false;
    }

    const startHour = localStart.getHours();
    const endHour = localEnd.getHours();

    return (
      startHour >= this.settings.workHourStart &&
      endHour <= this.settings.workHourEnd &&
      startHour < this.settings.workHourEnd
    );
  }

  private async findCalendarConflicts(
    slot: TimeSlot,
    userId: string
  ): Promise<Conflict[]> {
    const selectedCalendars = parseSelectedCalendars(
      this.settings.selectedCalendars
    );
    // Only check for conflicts if calendars are selected
    if (selectedCalendars.length === 0) {
      return [];
    }

    return this.calendarService.findConflicts(slot, selectedCalendars, userId);
  }

  private hasInMemoryConflict(slot: TimeSlot): boolean {
    // Check all project tasks for conflicts
    for (const [, projectTasks] of this.slotScorer
      .getScheduledTasks()
      .entries()) {
      for (const projectTask of projectTasks) {
        if (
          areIntervalsOverlapping(
            { start: slot.start, end: slot.end },
            { start: projectTask.start, end: projectTask.end }
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private async removeConflicts(
    slots: TimeSlot[],
    task: Task
  ): Promise<TimeSlot[]> {
    const availableSlots: TimeSlot[] = [];
    const selectedCalendars = parseSelectedCalendars(
      this.settings.selectedCalendars
    );

    // Prepare slots for batch checking
    const slotsToCheck = slots.map((slot) => ({
      slot,
      taskId: task.id,
    }));

    // Batch check conflicts
    const batchResults = await this.calendarService.findBatchConflicts(
      slotsToCheck,
      selectedCalendars,
      task.userId || "",
      task.id
    );

    // Process results and check for conflicts with in-memory scheduled tasks
    for (const result of batchResults) {
      // Add null check to prevent "Cannot read properties of undefined (reading 'slot')"
      if (!result || !result.slot) {
        continue;
      }

      if (result.conflicts.length === 0) {
        // Check for conflicts with in-memory scheduled tasks
        if (!this.hasInMemoryConflict(result.slot)) {
          availableSlots.push(result.slot);
        }
      } else {
        result.slot.conflicts = result.conflicts;
      }
    }

    return availableSlots;
  }

  // TODO: Buffer time implementation needs improvement:
  // 1. Currently only checks if buffers fit within work hours but doesn't prevent scheduling in buffer times
  // 2. Should check for conflicts during buffer periods
  // 3. Consider adjusting slot times to include the buffers
  // 4. Could factor buffer availability into slot scoring
  /**
   * A slot "has buffer time" when the buffer before and after it is free:
   * no calendar event and no other scheduled task. (Previously this only
   * checked that the buffers fell inside the global working hours, which
   * penalised the first slot of every day and ignored actual neighbours.)
   */
  private async applyBufferTimes(
    slots: TimeSlot[],
    task: Task
  ): Promise<TimeSlot[]> {
    if (!this.settings.bufferMinutes || slots.length === 0) {
      for (const slot of slots) slot.hasBufferTime = true;
      return slots;
    }

    const buffers = slots.flatMap((slot) => {
      const { beforeBuffer, afterBuffer } = this.calculateBufferTimes(slot);
      return [beforeBuffer, afterBuffer];
    });
    const results = await this.calendarService.findBatchConflicts(
      buffers.map((slot) => ({ slot, taskId: task.id })),
      parseSelectedCalendars(this.settings.selectedCalendars),
      task.userId || "",
      task.id
    );
    const isFree = (i: number) => {
      const r = results[i];
      return (
        !!r && r.conflicts.length === 0 && !this.hasInMemoryConflict(buffers[i])
      );
    };
    slots.forEach((slot, i) => {
      slot.hasBufferTime = isFree(2 * i) && isFree(2 * i + 1);
    });
    return slots;
  }

  private scoreSlot(slot: TimeSlot): number {
    const score = this.calculateBaseScore(slot);
    return score;
  }

  private calculateBaseScore(slot: TimeSlot): number {
    // Prefer earlier slots
    const now = newDate();
    const hoursSinceNow = differenceInHours(slot.start, now);
    return -hoursSinceNow; // Higher score for earlier slots
  }

  private scoreSlots(slots: TimeSlot[], task: Task): TimeSlot[] {
    return slots.map((slot) => {
      const score = this.slotScorer.scoreSlot(slot, task);
      return {
        ...slot,
        score: score.total,
      };
    });
  }

  private sortByScore(slots: TimeSlot[]): TimeSlot[] {
    return [...slots].sort((a, b) => b.score - a.score);
  }

  async addScheduledTaskConflict(task: Task): Promise<void> {
    if (task.scheduledStart && task.scheduledEnd) {
      // Add this task to the list of scheduled tasks
      // This will make it show up as a conflict for future slot checks
      const projectId = task.projectId || "none";
      const projectTasks =
        this.slotScorer.getScheduledTasks().get(projectId) || [];
      projectTasks.push({
        start: task.scheduledStart,
        end: task.scheduledEnd,
      });
      this.slotScorer.getScheduledTasks().set(projectId, projectTasks);
    }
  }
}
