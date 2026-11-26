"use client";

import { useEffect, useMemo, useState } from "react";

import { useRouter } from "next/navigation";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { HiOutlineSearch, HiX } from "react-icons/hi";
import {
  HiOutlineCalendar,
  HiOutlineClipboardList,
  HiOutlineCog,
  HiOutlineCollection,
  HiOutlineLightningBolt,
} from "react-icons/hi";
import { HiOutlineCheckCircle } from "react-icons/hi";

import { cn, formatShortcut } from "@/lib/utils";

import { useCommands } from "@/hooks/useCommands";

import { useCalendarStore, useViewStore } from "@/store/calendar";
import { useTaskStore } from "@/store/task";
import { useTaskModalStore } from "@/store/taskModal";

import { TaskStatus } from "@/types/task";

const MAX_RESULTS = 8;

interface SearchEvent {
  id: string;
  feedId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string | null;
}

const fmtDay = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const fmtTime = (d: Date | string) =>
  new Date(d).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
// Date-only due dates are stored at 00:00 UTC: show that calendar date
const fmtDue = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: new Date(d).getUTCHours() === 0 ? "UTC" : undefined,
  });

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [showAllCommands, setShowAllCommands] = useState(false);
  const { searchCommands, executeCommand, getAllCommands } = useCommands();
  const router = useRouter();
  const tasks = useTaskStore((s) => s.tasks);
  const feeds = useCalendarStore((s) => s.feeds);
  const [events, setEvents] = useState<SearchEvent[]>([]);

  // Make sure there is something to search, whichever page we're on
  useEffect(() => {
    if (!open) return;
    if (useTaskStore.getState().tasks.length === 0) {
      void useTaskStore.getState().fetchTasks();
    }
    if (useCalendarStore.getState().feeds.length === 0) {
      void useCalendarStore.getState().refreshFeeds();
    }
  }, [open]);

  // Events are searched on the server: the calendar only keeps the dates
  // it's showing loaded, but search should find any synced event
  const trimmed = search.trim();
  useEffect(() => {
    if (!open || trimmed.length < 2) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/events?${new URLSearchParams({ q: trimmed })}`
        );
        const found = res.ok ? await res.json() : [];
        if (!cancelled) setEvents(Array.isArray(found) ? found : []);
      } catch {
        if (!cancelled) setEvents([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmed]);

  const query = search.trim().toLowerCase();

  // Tasks matching title or description: open ones first, by due date
  const taskResults = useMemo(() => {
    if (query.length < 2) return [];
    return tasks
      .filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.description?.toLowerCase().includes(query)
      )
      .sort((a, b) => {
        const doneA = a.status === TaskStatus.COMPLETED ? 1 : 0;
        const doneB = b.status === TaskStatus.COMPLETED ? 1 : 0;
        if (doneA !== doneB) return doneA - doneB;
        const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return dueA - dueB;
      })
      .slice(0, MAX_RESULTS);
  }, [tasks, query]);

  // Events matching title, location or description: upcoming first (soonest
  // first), then past ones (most recent first)
  const eventResults = useMemo(() => {
    if (query.length < 2) return [];
    const now = Date.now();
    const seen = new Set<string>();
    return events
      .filter((e) => {
        const key = `${e.title}|${new Date(e.start).getTime()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const ta = new Date(a.start).getTime();
        const tb = new Date(b.start).getTime();
        const pa = ta < now ? 1 : 0;
        const pb = tb < now ? 1 : 0;
        if (pa !== pb) return pa - pb;
        return pa ? tb - ta : ta - tb;
      })
      .slice(0, MAX_RESULTS);
  }, [events, query]);

  const openTask = (taskId: string) => {
    useTaskModalStore.getState().setOpenTaskId(taskId);
    onOpenChange(false);
    router.push("/tasks");
  };

  const openEventDay = (start: Date | string) => {
    const view = useViewStore.getState();
    view.setDate(new Date(start));
    view.setView("day");
    onOpenChange(false);
    router.push("/calendar");
  };

  // Get filtered commands based on search or show all commands
  const commands = useMemo(() => {
    if (showAllCommands) {
      return getAllCommands();
    }
    return search ? searchCommands(search) : [];
  }, [search, searchCommands, showAllCommands, getAllCommands]);

  // Reset search and showAllCommands when opening/closing
  useEffect(() => {
    if (!open) {
      setSearch("");
      setShowAllCommands(false);
    }
  }, [open]);

  // Group commands by section for better organization
  const groupedCommands = useMemo(() => {
    const groups: Record<string, typeof commands> = {};

    commands.forEach((command) => {
      if (!groups[command.section]) {
        groups[command.section] = [];
      }
      groups[command.section].push(command);
    });

    return groups;
  }, [commands]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-full max-w-[640px] -translate-x-1/2">
          <Dialog.Title className="sr-only">Command Menu</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search commands and navigate the application
          </Dialog.Description>

          <Command
            shouldFilter={false}
            className={cn(
              "overflow-hidden rounded-lg border bg-white shadow-lg",
              "transform transition-all",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            )}
          >
            <div className="flex items-center border-b px-3">
              <HiOutlineSearch className="h-5 w-5 text-gray-400" />
              <Command.Input
                placeholder="Search tasks, events and commands..."
                className="h-12 flex-1 px-3 text-base outline-none placeholder:text-gray-400"
                value={search}
                onValueChange={setSearch}
              />
              {search && (
                <button
                  className="text-gray-400 hover:text-gray-600"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                >
                  <HiX className="h-5 w-5" />
                </button>
              )}
              {!search && (
                <kbd className="hidden items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-400 sm:flex">
                  <span className="text-xs">⌘</span>
                  <span>K</span>
                </kbd>
              )}
              <Dialog.Close
                className="ml-2 p-2 text-gray-400 hover:text-gray-600"
                aria-label="Close command menu"
              >
                <HiX className="h-5 w-5" />
              </Dialog.Close>
            </div>

            <Command.List className="max-h-[300px] overflow-y-auto p-2">
              {!search && !showAllCommands && (
                <div className="px-2 py-3 text-sm text-gray-500">
                  <p className="mb-2">
                    Start typing to search your tasks, events and commands, or
                    try these:
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div
                      className="flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-gray-100"
                      onClick={() => {
                        executeCommand("navigation.calendar");
                        onOpenChange(false);
                      }}
                    >
                      <HiOutlineCalendar className="h-4 w-4 text-gray-500" />
                      <span className="text-sm">Go to Calendar</span>
                      <kbd className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        gc
                      </kbd>
                    </div>
                    <div
                      className="flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-gray-100"
                      onClick={() => {
                        executeCommand("navigation.tasks");
                        onOpenChange(false);
                      }}
                    >
                      <HiOutlineClipboardList className="h-4 w-4 text-gray-500" />
                      <span className="text-sm">Go to Tasks</span>
                      <kbd className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        gt
                      </kbd>
                    </div>
                    <div
                      className="flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-gray-100"
                      onClick={() => {
                        executeCommand("navigation.focus");
                        onOpenChange(false);
                      }}
                    >
                      <HiOutlineLightningBolt className="h-4 w-4 text-gray-500" />
                      <span className="text-sm">Go to Focus</span>
                      <kbd className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        gf
                      </kbd>
                    </div>
                    <div
                      className="flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-gray-100"
                      onClick={() => {
                        executeCommand("navigation.settings");
                        onOpenChange(false);
                      }}
                    >
                      <HiOutlineCog className="h-4 w-4 text-gray-500" />
                      <span className="text-sm">Go to Settings</span>
                      <kbd className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        gs
                      </kbd>
                    </div>
                  </div>

                  <div className="mt-4 flex justify-center">
                    <button
                      onClick={() => setShowAllCommands(true)}
                      className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                    >
                      <HiOutlineCollection className="h-4 w-4" />
                      Show all commands
                    </button>
                  </div>
                </div>
              )}

              {taskResults.length > 0 && (
                <Command.Group heading="Tasks">
                  {taskResults.map((task) => {
                    const done = task.status === TaskStatus.COMPLETED;
                    return (
                      <Command.Item
                        key={`task-${task.id}`}
                        value={`task-${task.id}`}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-blue-50 aria-selected:text-blue-700"
                        onSelect={() => openTask(task.id)}
                      >
                        {done ? (
                          <HiOutlineCheckCircle className="h-4 w-4 flex-none text-gray-400" />
                        ) : (
                          <HiOutlineClipboardList className="h-4 w-4 flex-none" />
                        )}
                        <span
                          className={cn(
                            "truncate",
                            done && "text-gray-400 line-through"
                          )}
                        >
                          {task.title}
                        </span>
                        <span className="ml-auto flex-none text-xs text-gray-400">
                          {task.scheduledStart && !done
                            ? `${fmtDay(task.scheduledStart)} ${fmtTime(task.scheduledStart)}`
                            : task.dueDate
                              ? `due ${fmtDue(task.dueDate)}`
                              : ""}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {eventResults.length > 0 && (
                <Command.Group heading="Events">
                  {eventResults.map((event) => (
                    <Command.Item
                      key={`event-${event.id}`}
                      value={`event-${event.id}`}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-blue-50 aria-selected:text-blue-700"
                      onSelect={() => openEventDay(event.start)}
                    >
                      <span
                        className="h-2.5 w-2.5 flex-none rounded-full"
                        style={{
                          backgroundColor:
                            feeds.find((f) => f.id === event.feedId)?.color ||
                            "#3b82f6",
                        }}
                      />
                      <span className="truncate">{event.title}</span>
                      <span className="ml-auto flex-none text-xs text-gray-400">
                        {fmtDay(event.start)}
                        {!event.allDay && ` ${fmtTime(event.start)}`}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Empty className="py-6 text-center text-sm text-gray-500">
                No results found. Try a different search term.
              </Command.Empty>

              {(commands.length > 0 || showAllCommands) &&
                Object.entries(groupedCommands).map(
                  ([section, sectionCommands]) => (
                    <Command.Group
                      key={section}
                      heading={
                        section.charAt(0).toUpperCase() + section.slice(1)
                      }
                    >
                      {sectionCommands.map((command) => {
                        const Icon = command.icon;
                        return (
                          <Command.Item
                            key={command.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-blue-50 aria-selected:text-blue-700"
                            onSelect={() => {
                              executeCommand(command.id);
                              onOpenChange(false);
                            }}
                          >
                            {Icon && <Icon className="h-4 w-4" />}
                            <span>{command.title}</span>
                            {command.shortcut && (
                              <kbd className="ml-auto text-xs text-gray-400">
                                {formatShortcut(command.shortcut)}
                              </kbd>
                            )}
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  )
                )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
