"use client";

import { useEffect, useState } from "react";

import { ActionOverlay } from "@/components/ui/action-overlay";

import { useFocusModeStore } from "@/store/focusMode";

import { FocusedTask } from "./FocusedTask";
import { QuickActions } from "./QuickActions";
import { TaskQueue } from "./TaskQueue";

export function FocusMode() {
  const [mounted, setMounted] = useState(false);

  // Add hydration safety
  const {
    getCurrentTask,
    isProcessing,
    actionType,
    actionMessage,
    stopProcessing,
  } = useFocusModeStore();

  // Get current task and queued tasks - do this before any conditional returns
  const currentTask = getCurrentTask();

  // This effect will only run on the client
  useEffect(() => {
    setMounted(true);
  }, []);

  // If not mounted yet, render a simple loading state
  if (!mounted) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-lg text-muted-foreground">Loading focus mode...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {isProcessing && actionType && (
        <ActionOverlay
          type={actionType}
          message={actionMessage || undefined}
          onComplete={stopProcessing}
        />
      )}

      {/* Phones: one scrolling column (task, actions, queue).
          Desktop: queue | task | actions side by side */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {/* Queued tasks */}
        <aside className="order-3 border-t border-border md:order-none md:h-full md:w-80 md:flex-none md:border-r md:border-t-0">
          <TaskQueue />
        </aside>

        {/* Focused task */}
        <main className="order-1 p-3 sm:p-6 md:order-none md:flex-1 md:overflow-y-auto md:p-8">
          <FocusedTask task={currentTask} />
        </main>

        {/* Quick actions */}
        <aside className="order-2 border-t border-border md:order-none md:h-full md:w-64 md:flex-none md:border-l md:border-t-0">
          <QuickActions />
        </aside>
      </div>
    </div>
  );
}
