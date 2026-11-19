import { AutoScheduleSettings, Task } from "@prisma/client";

import { getEnergyLevelForTime } from "@/lib/autoSchedule";
import {
  differenceInHours,
  differenceInMinutes,
  newDate,
  toZonedTime,
} from "@/lib/date-utils";

import { EnergyLevel, SlotScore, TimeSlot } from "@/types/scheduling";
import { Priority } from "@/types/task";

interface ProjectTask {
  start: Date;
  end: Date;
}

export class SlotScorer {
  constructor(
    private settings: AutoScheduleSettings,
    private scheduledTasks: Map<string, ProjectTask[]> = new Map(),
    // The user's timezone: hour-of-day checks (energy levels, preferred
    // time) must use the user's wall clock, not the server's (often UTC)
    private timeZone: string = "UTC"
  ) {}

  private localHour(date: Date): number {
    return toZonedTime(date, this.timeZone).getHours();
  }

  /**
   * "As soon as possible": 1.0 now, halving every 24 hours. Used so that,
   * other factors being equal, the earliest suitable slot wins.
   */
  private earliness(slot: TimeSlot): number {
    const hoursToSlot = Math.max(
      0,
      differenceInMinutes(slot.start, newDate()) / 60
    );
    return Math.exp(-(Math.LN2 * hoursToSlot) / 24);
  }

  // Add method to update scheduled tasks
  updateScheduledTasks(tasks: Task[]) {
    this.scheduledTasks.clear();
    tasks.forEach((task) => {
      if (task.scheduledStart && task.scheduledEnd) {
        // Tasks without a project share the "none" bucket that
        // addScheduledTaskConflict uses, so hasInMemoryConflict sees them
        const key = task.projectId || "none";
        const projectTasks = this.scheduledTasks.get(key) || [];
        projectTasks.push({
          start: task.scheduledStart,
          end: task.scheduledEnd,
        });
        this.scheduledTasks.set(key, projectTasks);
      }
    });
  }

  scoreSlot(slot: TimeSlot, task: Task): SlotScore {
    const factors = {
      workHourAlignment: this.scoreWorkHourAlignment(slot),
      energyLevelMatch: this.scoreEnergyLevelMatch(slot, task),
      projectProximity: this.scoreProjectProximity(slot, task),
      bufferAdequacy: this.scoreBufferAdequacy(slot),
      timePreference: this.scoreTimePreference(slot, task),
      deadlineProximity: this.scoreDeadlineProximity(slot, task),
      priorityScore: this.scorePriority(task),
    };

    // Calculate total score (weighted average)
    const weights = {
      workHourAlignment: 1.0,
      energyLevelMatch: 1.5,
      projectProximity: 0.5,
      bufferAdequacy: 0.8,
      timePreference: 1.2,
      deadlineProximity: 3.0,
      priorityScore: 1.8,
    };

    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const weightedSum = Object.entries(factors).reduce((sum, [key, value]) => {
      const weight = weights[key as keyof typeof weights];
      const contribution = value * weight;
      return sum + contribution;
    }, 0);

    const total = weightedSum / totalWeight;

    return {
      total,
      factors,
    };
  }

  private scoreWorkHourAlignment(slot: TimeSlot): number {
    return slot.isWithinWorkHours ? 1 : 0;
  }

  private scoreEnergyLevelMatch(slot: TimeSlot, task: Task): number {
    if (!task.energyLevel) return 0.5; // Neutral score if task has no energy level

    const slotEnergy = getEnergyLevelForTime(
      this.localHour(slot.start),
      this.settings
    );
    if (!slotEnergy) return 0.5; // Neutral score if time has no energy level

    // Exact match gets 1.0, adjacent levels get 0.5, opposite levels get 0
    const energyLevels: EnergyLevel[] = ["high", "medium", "low"];
    const taskEnergyIndex = energyLevels.indexOf(
      task.energyLevel as EnergyLevel
    );
    const slotEnergyIndex = energyLevels.indexOf(slotEnergy);

    const distance = Math.abs(taskEnergyIndex - slotEnergyIndex);
    return distance === 0 ? 1 : distance === 1 ? 0.5 : 0;
  }

  private scoreBufferAdequacy(slot: TimeSlot): number {
    if (!slot.hasBufferTime) return 0;
    return 1; // For now, simple boolean score
  }

  private scoreTimePreference(slot: TimeSlot, task: Task): number {
    // Inside the preferred window (in the user's timezone) earlier is better;
    // outside it scores 0. Without a preference, earlier is simply better.
    if (task.preferredTime) {
      const hour = this.localHour(slot.start);
      const preference = task.preferredTime.toLowerCase();
      const ranges = {
        morning: { start: 5, end: 12 },
        afternoon: { start: 12, end: 17 },
        evening: { start: 17, end: 22 },
      };
      const range = ranges[preference as keyof typeof ranges];
      if (!range) return this.earliness(slot);
      return hour >= range.start && hour < range.end ? this.earliness(slot) : 0;
    }

    return this.earliness(slot);
  }

  private scoreDeadlineProximity(slot: TimeSlot, task: Task): number {
    if (!task.dueDate) {
      return 0.5; // Neutral score for no due date
    }

    const now = newDate();
    // Due dates are date-only (stored as 00:00 UTC), so the deadline is the
    // END of the due day, not its start.
    const effectiveDue = new Date(task.dueDate.getTime() + 24 * 60 * 60 * 1000);

    // Overdue already: boost the task (1.0 to 2.0 by how overdue it is) so it
    // is scheduled before others, and prefer earlier slots.
    const minutesOverdue = differenceInMinutes(now, effectiveDue);
    if (minutesOverdue > 0) {
      const daysOverdue = minutesOverdue / (24 * 60);
      const baseScore = Math.min(2.0, 1.0 + daysOverdue / 14);
      const daysToSlot = differenceInMinutes(slot.start, now) / (24 * 60);
      const timePenalty = Math.min(0.5, daysToSlot / 14);
      return baseScore * (1 - timePenalty);
    }

    // Slot after the deadline: penalise lateness
    const minutesToDeadline = differenceInMinutes(effectiveDue, slot.start);
    if (minutesToDeadline < 0) {
      const daysLate = -minutesToDeadline / (24 * 60);
      return Math.max(0, 0.3 - 0.3 * Math.min(1, daysLate / 7));
    }

    // Slot meets the deadline: score the task's urgency (how soon it is due
    // from now), the same for every on-time slot. This keeps urgent tasks
    // ahead of others without rewarding slots for being closer to the
    // deadline, which used to push work as late as possible.
    const daysLeft = differenceInMinutes(effectiveDue, now) / (24 * 60);
    return Math.min(1, Math.exp(-daysLeft / 3));
  }

  private scoreProjectProximity(slot: TimeSlot, task: Task): number {
    if (!task.projectId || !this.settings.groupByProject) return 0.5;

    const projectTasks = this.scheduledTasks.get(task.projectId);
    if (!projectTasks || projectTasks.length === 0) return 0.5;

    // Find the closest task from the same project
    const hourDistances = projectTasks.map((projectTask) => {
      // Check distance to both start and end of the task
      const distanceToStart = Math.abs(
        differenceInHours(slot.start, projectTask.start)
      );
      const distanceToEnd = Math.abs(
        differenceInHours(slot.end, projectTask.end)
      );
      return Math.min(distanceToStart, distanceToEnd);
    });

    const closestDistance = Math.min(...hourDistances);

    // Score based on proximity (exponential decay)
    // Perfect score (1.0) if within 1 hour
    // 0.7 if within 2 hours
    // 0.5 if within 4 hours
    // Approaches 0 as distance increases
    return Math.exp(-closestDistance / 4);
  }

  private scorePriority(task: Task): number {
    if (!task.priority || task.priority === Priority.NONE) return 0.25;

    // Higher priority tasks get higher scores
    switch (task.priority) {
      case Priority.HIGH:
        return 1.0;
      case Priority.MEDIUM:
        return 0.75;
      case Priority.LOW:
        return 0.5;
      default:
        return 0.25;
    }
  }

  // Getter for scheduledTasks to allow TimeSlotManager to update it
  getScheduledTasks(): Map<string, ProjectTask[]> {
    return this.scheduledTasks;
  }
}
