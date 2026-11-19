"use client";

import { useEffect, useMemo, useState } from "react";

import { IoAdd, IoCopyOutline, IoStar, IoTrashOutline } from "react-icons/io5";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import {
  ScheduleBlock,
  ScheduleBlocks,
  WEEKDAYS,
  parseScheduleBlocks,
  toMinutes,
  weeklyMinutes,
} from "@/lib/schedules";
import { cn } from "@/lib/utils";

import { useScheduleStore } from "@/store/schedules";

import { Schedule } from "@/types/schedule";

import { SettingsSection } from "./SettingsSection";

// Monday-first display order (keys stay 0 = Sunday ... 6 = Saturday)
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_KEYS = ["1", "2", "3", "4", "5"];

const formatHours = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

/** 24-hour bar showing a day's blocks */
function DayBar({ blocks }: { blocks: ScheduleBlock[] }) {
  return (
    <div className="relative h-2 w-full rounded-full bg-muted">
      {blocks.map((b, i) => {
        const start = toMinutes(b.start);
        const end = toMinutes(b.end);
        if (!(end > start)) return null;
        return (
          <div
            key={i}
            className="absolute inset-y-0 rounded-full bg-primary"
            style={{
              left: `${(start / 1440) * 100}%`,
              width: `${((end - start) / 1440) * 100}%`,
            }}
          />
        );
      })}
    </div>
  );
}

interface Draft {
  name: string;
  isDefault: boolean;
  blocks: ScheduleBlocks;
}

const toDraft = (s?: Schedule): Draft => ({
  name: s?.name ?? "",
  isDefault: s?.isDefault ?? false,
  blocks: parseScheduleBlocks(s?.blocks ?? {}),
});

function validate(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the schedule a name";
  for (const [day, list] of Object.entries(draft.blocks)) {
    for (const b of list ?? []) {
      if (!b.start || !b.end) return `${WEEKDAYS[+day]}: fill in both times`;
      if (toMinutes(b.end) <= toMinutes(b.start)) {
        return `${WEEKDAYS[+day]}: ${b.start}-${b.end} ends before it starts`;
      }
    }
  }
  return null;
}

export function ScheduleSettings() {
  const {
    schedules,
    loaded,
    fetchSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
  } = useScheduleStore();
  // null = nothing selected, "new" = creating
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSchedules().catch((e) => toast.error(e.message));
  }, [fetchSchedules]);

  // Select the first schedule once loaded
  useEffect(() => {
    if (loaded && selectedId === null && schedules.length) {
      setSelectedId(schedules[0].id);
      setDraft(toDraft(schedules[0]));
    }
  }, [loaded, schedules, selectedId]);

  const selected = useMemo(
    () => schedules.find((s) => s.id === selectedId),
    [schedules, selectedId]
  );
  const isNew = selectedId === "new";
  const dirty =
    isNew || JSON.stringify(toDraft(selected)) !== JSON.stringify({ ...draft });

  const select = (s: Schedule) => {
    setSelectedId(s.id);
    setDraft(toDraft(s));
  };

  const startNew = () => {
    setSelectedId("new");
    setDraft({
      name: "",
      isDefault: schedules.length === 0,
      blocks: Object.fromEntries(
        WEEKDAY_KEYS.map((d) => [d, [{ start: "09:00", end: "17:00" }]])
      ),
    });
  };

  const setDay = (day: string, list: ScheduleBlock[]) =>
    setDraft((d) => ({ ...d, blocks: { ...d.blocks, [day]: list } }));

  const addBlock = (day: string) => {
    const list = draft.blocks[day] ?? [];
    const last = list[list.length - 1];
    const start = last ? last.end : "09:00";
    const startMin = Math.min(toMinutes(start), 23 * 60);
    const endMin = Math.min(startMin + 60, 24 * 60);
    const fmt = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    setDay(day, [...list, { start: fmt(startMin), end: fmt(endMin) }]);
  };

  const copyToWeekdays = (day: string) => {
    const list = draft.blocks[day] ?? [];
    setDraft((d) => ({
      ...d,
      blocks: {
        ...d.blocks,
        ...Object.fromEntries(
          WEEKDAY_KEYS.map((k) => [k, list.map((b) => ({ ...b }))])
        ),
      },
    }));
  };

  const save = async () => {
    const problem = validate(draft);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        isDefault: draft.isDefault,
        blocks: draft.blocks,
      };
      if (isNew) {
        const created = await createSchedule(payload);
        setSelectedId(created.id);
        setDraft(toDraft(created));
        toast.success(`Created "${created.name}"`);
      } else if (selected) {
        const updated = await updateSchedule(selected.id, payload);
        setDraft(toDraft(updated));
        toast.success(`Saved "${updated.name}"`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save schedule");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const count = selected._count?.tasks ?? 0;
    const ok = window.confirm(
      count
        ? `Delete "${selected.name}"? ${count} task(s) will fall back to the default schedule.`
        : `Delete "${selected.name}"?`
    );
    if (!ok) return;
    try {
      await deleteSchedule(selected.id);
      setSelectedId(null);
      setDraft(toDraft());
      toast.success(`Deleted "${selected.name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <SettingsSection
      title="Schedules"
      description="Named weekly time windows, like Motion's schedules. Auto-scheduling only places a task inside its schedule's hours. Tasks without a schedule use the default schedule, or the Auto-Schedule working hours if there is no default."
    >
      <div className="flex flex-col gap-6 md:flex-row">
        {/* List */}
        <div className="w-full space-y-1 md:w-64 md:shrink-0">
          {schedules.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => select(s)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                s.id === selectedId && "bg-muted font-medium"
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {s.isDefault && (
                  <IoStar
                    className="h-3.5 w-3.5 shrink-0 text-amber-500"
                    title="Default schedule"
                  />
                )}
                <span className="truncate">{s.name}</span>
              </span>
              <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                {formatHours(weeklyMinutes(parseScheduleBlocks(s.blocks)))}
              </span>
            </button>
          ))}
          {loaded && schedules.length === 0 && !isNew && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No schedules yet.
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            onClick={startNew}
          >
            <IoAdd className="mr-1 h-4 w-4" /> New schedule
          </Button>
        </div>

        {/* Editor */}
        {(selected || isNew) && (
          <div className="min-w-0 flex-1 space-y-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="schedule-name">Name</Label>
                <Input
                  id="schedule-name"
                  value={draft.name}
                  placeholder="e.g. Work hours"
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="schedule-default"
                  checked={draft.isDefault}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({ ...d, isDefault: v }))
                  }
                />
                <Label htmlFor="schedule-default">Default</Label>
              </div>
            </div>

            <div className="text-sm text-muted-foreground">
              {formatHours(weeklyMinutes(draft.blocks))} per week
              {selected?._count?.tasks
                ? ` · used by ${selected._count.tasks} task(s)`
                : ""}
            </div>

            <div className="divide-y rounded-md border">
              {DAY_ORDER.map((dayNum) => {
                const day = String(dayNum);
                const list = draft.blocks[day] ?? [];
                return (
                  <div
                    key={day}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start"
                  >
                    <div className="w-28 shrink-0 pt-1.5 text-sm font-medium">
                      {WEEKDAYS[dayNum]}
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      {list.length === 0 && (
                        <div className="pt-1.5 text-sm text-muted-foreground">
                          Unavailable
                        </div>
                      )}
                      {list.map((b, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            type="time"
                            step={300}
                            value={b.start}
                            className="w-28"
                            aria-label={`${WEEKDAYS[dayNum]} start ${i + 1}`}
                            onChange={(e) =>
                              setDay(
                                day,
                                list.map((x, j) =>
                                  j === i ? { ...x, start: e.target.value } : x
                                )
                              )
                            }
                          />
                          <span className="text-muted-foreground">–</span>
                          <Input
                            type="time"
                            step={300}
                            value={b.end === "24:00" ? "23:59" : b.end}
                            className="w-28"
                            aria-label={`${WEEKDAYS[dayNum]} end ${i + 1}`}
                            onChange={(e) =>
                              setDay(
                                day,
                                list.map((x, j) =>
                                  j === i ? { ...x, end: e.target.value } : x
                                )
                              )
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Remove"
                            onClick={() =>
                              setDay(
                                day,
                                list.filter((_, j) => j !== i)
                              )
                            }
                          >
                            <IoTrashOutline className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <DayBar blocks={list} />
                    </div>
                    <div className="flex shrink-0 gap-1 sm:pt-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addBlock(day)}
                      >
                        <IoAdd className="mr-1 h-4 w-4" /> Add
                      </Button>
                      {list.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title="Copy these hours to Monday-Friday"
                          onClick={() => copyToWeekdays(day)}
                        >
                          <IoCopyOutline className="mr-1 h-4 w-4" /> Mon–Fri
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between">
              <div>
                {selected && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive"
                    onClick={remove}
                  >
                    <IoTrashOutline className="mr-1 h-4 w-4" /> Delete
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {dirty && !isNew && <Badge variant="outline">Unsaved</Badge>}
                {isNew && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSelectedId(schedules[0]?.id ?? null);
                      setDraft(toDraft(schedules[0]));
                    }}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={save}
                  disabled={saving || !dirty}
                >
                  {saving ? "Saving…" : isNew ? "Create" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
