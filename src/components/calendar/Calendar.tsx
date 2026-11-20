"use client";

import { useEffect } from "react";

import dynamic from "next/dynamic";

import { HiMenu } from "react-icons/hi";
import { IoChevronBack, IoChevronForward } from "react-icons/io5";

import { DayView } from "@/components/calendar/DayView";
import { FeedManager } from "@/components/calendar/FeedManager";
import { MonthView } from "@/components/calendar/MonthView";
import { MultiMonthView } from "@/components/calendar/MultiMonthView";
import { WeekView } from "@/components/calendar/WeekView";

import { isSaasEnabled } from "@/lib/config";
// import { SponsorshipBanner } from "@/components/ui/sponsorship-banner";
import {
  addDays,
  format,
  formatDate,
  newDate,
  subDays,
} from "@/lib/date-utils";
import { cn } from "@/lib/utils";

import { useAutoSchedule } from "@/hooks/use-auto-schedule";

import {
  useCalendarStore,
  useCalendarUIStore,
  useViewStore,
} from "@/store/calendar";
import { useTaskStore } from "@/store/task";

import { CalendarEvent, CalendarFeed } from "@/types/calendar";

// Dynamically import the appropriate version of the LifetimeAccessBanner
const LifetimeAccessBanner = dynamic(
  () =>
    import(`./LifetimeAccessBanner.${isSaasEnabled ? "saas" : "open"}`).then(
      (mod) => mod.LifetimeAccessBanner
    ),
  { ssr: false } // Disable SSR for this component to prevent import errors
);

interface CalendarProps {
  initialFeeds?: CalendarFeed[];
  initialEvents?: CalendarEvent[];
}

export function Calendar({
  initialFeeds = [],
  initialEvents = [],
}: CalendarProps) {
  const { date: currentDate, setDate, view, setView } = useViewStore();
  const { isSidebarOpen, setSidebarOpen, isHydrated } = useCalendarUIStore();
  const { setFeeds, setEvents } = useCalendarStore();

  // Use initial data from server for hydration
  useEffect(() => {
    if (initialFeeds.length > 0) {
      setFeeds(initialFeeds);
    }

    if (initialEvents.length > 0) {
      setEvents(initialEvents);
    }

    // Only fetch from database if we didn't get initial data
    if (!initialFeeds.length || !initialEvents.length) {
      useCalendarStore.getState().loadFromDatabase();
    }

    // Always fetch tasks since they're not pre-loaded
    useTaskStore.getState().fetchTasks();
  }, [initialFeeds, initialEvents, setFeeds, setEvents]);

  // Keep the calendar current while the page stays open: reload events and
  // tasks when you come back to it (tab switch or window focus; a Mac app
  // switch only fires "focus") and every 5 minutes while it's visible, so
  // background syncs and Auto Schedule runs show up without a page refresh
  useEffect(() => {
    let lastRefresh = Date.now();
    const refresh = (minGapMs: number) => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh < minGapMs) return;
      lastRefresh = Date.now();
      void useCalendarStore.getState().loadFromDatabase();
      void useTaskStore.getState().fetchTasks();
    };
    const onReturn = () => refresh(30_000);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    const timer = window.setInterval(() => refresh(4 * 60_000), 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.clearInterval(timer);
    };
  }, []);

  const handlePrevWeek = () => {
    if (view === "month" || view === "multiMonth") {
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() - 1);
      setDate(newDate);
    } else {
      const days = view === "day" ? 1 : 7;
      setDate(subDays(currentDate, days));
    }
  };

  const handleNextWeek = () => {
    if (view === "month" || view === "multiMonth") {
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() + 1);
      setDate(newDate);
    } else {
      const days = view === "day" ? 1 : 7;
      setDate(addDays(currentDate, days));
    }
  };

  const { runAutoSchedule, isScheduling } = useAutoSchedule();

  return (
    <div className="relative flex h-full w-full">
      {/* Sidebar: overlays the calendar on phones, pushes it aside on desktop */}
      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-30 h-full w-80 max-w-[85vw] flex-none border-r border-gray-200 bg-white shadow-lg md:relative md:z-auto md:shadow-none",
          "transform transition-transform duration-300 ease-in-out",
          !isHydrated && "opacity-0 duration-0",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ marginLeft: isSidebarOpen ? 0 : "-20rem" }}
      >
        <div className="flex h-full flex-col">
          {/* Feed Manager */}
          <div className="flex-1 overflow-y-auto">
            <FeedManager />
          </div>

          {/* Sponsorship Banner */}
          {/* <SponsorshipBanner /> */}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Lifetime Access Banner */}
        <LifetimeAccessBanner />
        {/* Header */}
        <header className="flex min-h-16 flex-none flex-wrap items-center gap-y-1 border-b border-border px-2 py-2 sm:h-16 sm:flex-nowrap sm:px-4 sm:py-0">
          <button
            onClick={() => setSidebarOpen(!isSidebarOpen)}
            className="rounded-lg p-2 text-foreground hover:bg-muted"
            title="Toggle Sidebar (b)"
          >
            <HiMenu className="h-5 w-5" />
          </button>

          <div className="ml-1 flex min-w-0 items-center gap-1 sm:ml-4 sm:gap-4">
            <button
              onClick={() => setDate(newDate())}
              className="rounded-lg px-2 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:px-3"
              title="Go to Today (t)"
            >
              Today
            </button>

            <button
              onClick={runAutoSchedule}
              disabled={isScheduling}
              aria-busy={isScheduling}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:cursor-wait disabled:opacity-70 sm:px-3"
            >
              {isScheduling && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {isScheduling ? "Scheduling…" : "Auto Schedule"}
            </button>

            <div className="flex items-center sm:gap-2">
              <button
                onClick={handlePrevWeek}
                className="rounded-lg p-1.5 text-foreground hover:bg-muted"
                data-testid="calendar-prev-week"
                title="Previous Week (←)"
              >
                <IoChevronBack className="h-5 w-5" />
              </button>
              <button
                onClick={handleNextWeek}
                className="rounded-lg p-1.5 text-foreground hover:bg-muted"
                data-testid="calendar-next-week"
                title="Next Week (→)"
              >
                <IoChevronForward className="h-5 w-5" />
              </button>
            </div>

            <h1 className="truncate text-base font-semibold text-foreground sm:text-xl">
              <span className="hidden sm:inline">
                {formatDate(currentDate)}
              </span>
              <span className="sm:hidden">{format(currentDate, "MMM d")}</span>
            </h1>
          </div>

          {/* View Switching Buttons */}
          <div className="flex w-full items-center justify-end gap-1 sm:ml-auto sm:w-auto sm:gap-2">
            <button
              onClick={() => setView("day")}
              className={cn(
                "rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3",
                view === "day"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Day
            </button>
            <button
              onClick={() => setView("week")}
              className={cn(
                "rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3",
                view === "week"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Week
            </button>
            <button
              onClick={() => setView("month")}
              className={cn(
                "rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3",
                view === "month"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Month
            </button>
            <button
              onClick={() => setView("multiMonth")}
              className={cn(
                "rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3",
                view === "multiMonth"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Year
            </button>
          </div>
        </header>

        {/* Calendar Grid */}
        <div className="flex-1 overflow-hidden">
          {view === "day" ? (
            <DayView currentDate={currentDate} onDateClick={setDate} />
          ) : view === "week" ? (
            <WeekView currentDate={currentDate} onDateClick={setDate} />
          ) : view === "month" ? (
            <MonthView currentDate={currentDate} onDateClick={setDate} />
          ) : (
            <MultiMonthView currentDate={currentDate} onDateClick={setDate} />
          )}
        </div>
      </main>
    </div>
  );
}
