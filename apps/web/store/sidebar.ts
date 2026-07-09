'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SidebarState {
  open: boolean;
  toggleSidebar: () => void;
  setOpen: (open: boolean) => void;
  width: number;
  setWidth: (width: number) => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    set => ({
      open: true,
      width: 240,
      toggleSidebar: () => set(state => ({ open: !state.open })),
      setOpen: (open: boolean) => set({ open }),
      setWidth: (width: number) => set({ width }),
      resizing: false,
      setResizing: (resizing: boolean) => set({ resizing }),
    }),
    {
      name: 'sidebar-storage',
      partialize: state => ({
        open: state.open,
        width: state.width,
      }),
    }
  )
);
