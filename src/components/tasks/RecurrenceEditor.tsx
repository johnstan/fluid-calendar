"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  RecurrenceFreq,
  TaskRecurrence,
  WEEKDAYS,
  buildTaskRecurrence,
  describeTaskRecurrence,
  parseTaskRecurrence,
} from "@/lib/task-recurrence";
import { cn } from "@/lib/utils";

const DEFAULT: TaskRecurrence = { freq: "weekly", interval: 1, weekdays: [0] };

const PRESETS: { label: string; days: number[] }[] = [
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Weekdays", days: [0, 1, 2, 3, 4] },
  { label: "Weekends", days: [5, 6] },
];

interface RecurrenceEditorProps {
  /** Rule in standard RRule form (with or without RRULE: prefix) */
  value?: string;
  onChange: (rule: string) => void;
}

/** Repeat interval/frequency plus, for weekly rules, which days. */
export function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  const parsed = parseTaskRecurrence(value);
  const current = parsed ?? DEFAULT;
  const update = (next: Partial<TaskRecurrence>) =>
    onChange(buildTaskRecurrence({ ...current, ...next }));

  const toggleDay = (day: number) => {
    const has = current.weekdays.includes(day);
    // Keep at least one day selected
    if (has && current.weekdays.length === 1) return;
    update({
      weekdays: has
        ? current.weekdays.filter((d) => d !== day)
        : [...current.weekdays, day],
    });
  };

  const summary = describeTaskRecurrence(buildTaskRecurrence(current));

  return (
    <div className="space-y-3">
      <div>
        <Label>Repeat every</Label>
        <div className="mt-1 flex items-center gap-2">
          <Input
            type="number"
            min="1"
            value={current.interval}
            onChange={(e) =>
              update({ interval: parseInt(e.target.value, 10) || 1 })
            }
            className="w-20"
          />
          <Select
            value={current.freq}
            onValueChange={(freq) =>
              update({
                freq: freq as RecurrenceFreq,
                weekdays: current.weekdays.length ? current.weekdays : [0],
              })
            }
          >
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">days</SelectItem>
              <SelectItem value="weekly">weeks</SelectItem>
              <SelectItem value="monthly">months</SelectItem>
              <SelectItem value="yearly">years</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {current.freq === "weekly" && (
        <div>
          <Label>On</Label>
          <div className="mt-1 flex flex-wrap gap-1">
            {WEEKDAYS.map((d) => {
              const on = current.weekdays.includes(d.idx);
              return (
                <button
                  key={d.idx}
                  type="button"
                  title={d.short}
                  aria-label={d.short}
                  aria-pressed={on}
                  onClick={() => toggleDay(d.idx)}
                  className={cn(
                    "h-8 w-8 rounded-full border text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-muted-foreground hover:bg-muted"
                  )}
                >
                  {d.letter}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => update({ interval: 1, weekdays: p.days })}
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!parsed && value && (
        <p className="text-xs text-amber-600">
          This task&apos;s current rule ({value}) can&apos;t be shown here;
          changing anything above replaces it.
        </p>
      )}
      {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
    </div>
  );
}
