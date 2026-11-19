"use client";

import { useEffect, useState } from "react";

import { IoCarOutline, IoChevronDown } from "react-icons/io5";
import { toast } from "sonner";

const OPTIONS = [0, 5, 10, 15, 20, 30, 45, 60, 75, 90, 120];

interface TravelState {
  beforeMinutes: number;
  afterMinutes: number;
  allOccurrences: boolean;
  isRecurring: boolean;
}

const label = (m: number) =>
  m === 0
    ? "None"
    : m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}`;

function withCurrent(value: number) {
  return OPTIONS.includes(value)
    ? OPTIONS
    : [...OPTIONS, value].sort((a, b) => a - b);
}

/**
 * Travel time before/after a calendar event. Saved per event (or for every
 * occurrence of a recurring event); only the auto-scheduler uses it.
 */
export function EventTravelEditor({ eventId }: { eventId: string }) {
  const [state, setState] = useState<TravelState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    fetch(`/api/event-travel?eventId=${encodeURIComponent(eventId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TravelState | null) => {
        if (!cancelled && data) setState(data);
      })
      .catch(() => {
        // Event not stored locally (e.g. expanded occurrence): hide editor
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!state) return null;

  const save = async (next: TravelState) => {
    const previous = state;
    setState(next);
    setSaving(true);
    try {
      const res = await fetch("/api/event-travel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          beforeMinutes: next.beforeMinutes,
          afterMinutes: next.afterMinutes,
          allOccurrences: next.allOccurrences,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setState(await res.json());
      toast.success("Travel time saved", {
        description: "Run Auto Schedule to move tasks around it.",
      });
    } catch {
      setState(previous);
      toast.error("Couldn't save travel time");
    } finally {
      setSaving(false);
    }
  };

  const select = (field: "beforeMinutes" | "afterMinutes", aria: string) => (
    <span className="relative inline-flex">
      <select
        aria-label={aria}
        value={state[field]}
        disabled={saving}
        onChange={(e) => save({ ...state, [field]: Number(e.target.value) })}
        className="h-7 appearance-none rounded-md border border-input bg-background py-0 pl-2 pr-6 text-xs text-foreground"
      >
        {withCurrent(state[field]).map((m) => (
          <option key={m} value={m}>
            {label(m)}
          </option>
        ))}
      </select>
      <IoChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
    </span>
  );

  return (
    <div className="flex items-start gap-2">
      <IoCarOutline className="mt-1.5 h-4 w-4 flex-shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span>Travel before</span>
          {select("beforeMinutes", "Travel time before")}
          <span>after</span>
          {select("afterMinutes", "Travel time after")}
        </div>
        {state.isRecurring && (
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={state.allOccurrences}
              disabled={saving}
              onChange={(e) =>
                save({ ...state, allOccurrences: e.target.checked })
              }
            />
            All occurrences
          </label>
        )}
      </div>
    </div>
  );
}
