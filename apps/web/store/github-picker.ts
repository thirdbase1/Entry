import { create } from 'zustand';

/**
 * Controls the "Start with GitHub" repo picker modal. The modal can be
 * opened from two places: the sidebar button and the `?github_picker=1`
 * URL param (which GitHub's update-repo-access redirect sets). This
 * store lets both open/close the same modal instance rendered in
 * MainLayout without prop-drilling across the sidebar/main boundary.
 */
interface GithubPickerState {
  open: boolean;
  openPicker: () => void;
  closePicker: () => void;
}

export const useGithubPicker = create<GithubPickerState>((set) => ({
  open: false,
  openPicker: () => set({ open: true }),
  closePicker: () => set({ open: false }),
}));
