import { create } from "zustand";

interface TaskModalStore {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  /** Task to open in the task card once the tasks page has it (e.g. from search) */
  openTaskId: string | null;
  setOpenTaskId: (id: string | null) => void;
}

export const useTaskModalStore = create<TaskModalStore>((set) => ({
  isOpen: false,
  setOpen: (open) => set({ isOpen: open }),
  openTaskId: null,
  setOpenTaskId: (id) => set({ openTaskId: id }),
}));
