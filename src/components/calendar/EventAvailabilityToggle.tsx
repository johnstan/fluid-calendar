"use client";

import { useEffect, useState } from "react";

import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { useCalendarStore } from "@/store/calendar";
import { useTaskStore } from "@/store/task";

interface EventAvailabilityToggleProps {
  eventId: string;
  feedId: string;
  isFree: boolean;
  isRecurring: boolean;
}

/** Busy / Free switch for a calendar event (Google and Fluid calendars). */
export function EventAvailabilityToggle({
  eventId,
  feedId,
  isFree: initial,
  isRecurring,
}: EventAvailabilityToggleProps) {
  const feedType = useCalendarStore(
    (s) => s.feeds.find((f) => f.id === feedId)?.type
  );
  const [isFree, setIsFree] = useState(initial);
  const [allOccurrences, setAllOccurrences] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setIsFree(initial), [initial, eventId]);

  // LOCAL feeds exist at runtime though the client feed type omits them
  const editable = feedType === "GOOGLE" || (feedType as string) === "LOCAL";

  const save = async (next: boolean) => {
    if (next === isFree || saving) return;
    const previous = isFree;
    setIsFree(next);
    setSaving(true);
    try {
      const res = await fetch("/api/event-availability", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, isFree: next, allOccurrences }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Request failed");
      }
      // Refresh the calendar and reschedule tasks around the change
      void useCalendarStore.getState().loadFromDatabase();
      useTaskStore.getState().queueBackgroundSchedule();
      toast.success(next ? "Marked as free" : "Marked as busy");
    } catch (error) {
      setIsFree(previous);
      toast.error("Couldn't change busy/free", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const option = (value: boolean, label: string) => (
    <button
      type="button"
      disabled={!editable || saving}
      aria-pressed={isFree === value}
      onClick={() => save(value)}
      className={cn(
        "px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-default",
        isFree === value
          ? "bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted"
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>Show as</span>
      <div
        className="inline-flex overflow-hidden rounded-md border border-input"
        title={
          editable
            ? "Free events don't block auto-scheduling"
            : "Busy/free can only be changed for Google and Fluid calendars"
        }
      >
        {option(false, "Busy")}
        {option(true, "Free")}
      </div>
      {editable && isRecurring && (
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={allOccurrences}
            disabled={saving}
            onChange={(e) => setAllOccurrences(e.target.checked)}
          />
          All occurrences
        </label>
      )}
    </div>
  );
}
