'use client';

import { create } from 'zustand';
import { useMemo } from 'react';

export interface GenericLibraryMetadata {
  collected: boolean;
}

export interface Chat extends GenericLibraryMetadata {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  type: 'chat';
}

export interface FileItem extends GenericLibraryMetadata {
  fileId: string;
  fileName: string;
  fileType: string | null;
  mimeType: string;
  blobId: string | null;
  createdAt: string;
  updatedAt: string;
  type: 'file';
}

export type AllItem = Chat | FileItem;

export interface LibraryState {
  chats: Chat[];
  files: FileItem[];
  loading: boolean;
  initialized: boolean;
  refresh: () => Promise<void>;
  toggleCollect: (type: 'chat' | 'file', id: string) => Promise<void>;
  deleteChat: (sessionId: string) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
  /**
   * Optimistic insert for a chat that was just created client-side, before
   * `refresh()` has ever fetched it from the server. See direct-chat-
   * interface.tsx's onSend (2026-07-23, "chat should be created instantly
   * I send message") -- preSave already persists the row synchronously
   * server-side by the time this fires, so this is purely a UI-latency
   * fix, not a race against the write itself. No-op if a chat with this
   * sessionId is already present (e.g. a later refresh() already landed
   * first, or this somehow double-fires) so it can never create a
   * duplicate row in the list.
   */
  addLocalChat: (sessionId: string, title: string | null) => void;
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  loading: false,
  initialized: false,
  chats: [],
  files: [],
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });

    try {
      const [chatsRes, filesRes] = await Promise.all([
        fetch('/api/chats').then(r => r.json()).catch(() => ({ sessions: [] })),
        fetch('/api/copilot/files').then(r => r.json()).catch(() => ({ files: [] })),
      ]);

      const chats: Chat[] = (chatsRes.sessions || []).map((s: any) => ({
        type: 'chat' as const,
        sessionId: s.id,
        title: s.title || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        collected: s.collected || false,
      }));

      const files: FileItem[] = (filesRes.files || []).map((f: any) => ({
        type: 'file' as const,
        fileId: f.id,
        fileName: f.name || 'Unknown',
        fileType: f.type || null,
        mimeType: f.mimeType || 'application/octet-stream',
        blobId: f.blobId || null,
        createdAt: f.created_date,
        updatedAt: f.updated_date,
        collected: f.collected || false,
      }));

      set({ chats, files, loading: false, initialized: true });
    } catch (error) {
      console.error('library:refresh error', error);
      set({ loading: false, initialized: true });
    }
  },
  toggleCollect: async (type, id) => {
    set(state => {
      if (type === 'chat') {
        return { chats: state.chats.map(c => c.sessionId === id ? { ...c, collected: !c.collected } : c) };
      }
      if (type === 'file') {
        return { files: state.files.map(f => f.fileId === id ? { ...f, collected: !f.collected } : f) };
      }
      return {};
    });

    try {
      if (type === 'chat') {
        await fetch(`/api/chats/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toggleCollected: true }),
        });
      }
    } catch (error) {
      console.error('library:toggleCollect error', error);
    }
  },
  deleteChat: async (sessionId) => {
    set(state => ({ chats: state.chats.filter(c => c.sessionId !== sessionId) }));
    try {
      await fetch(`/api/chats/${sessionId}`, { method: 'DELETE' });
    } catch (error) {
      console.error('library:deleteChat error', error);
    }
  },
  deleteFile: async (fileId) => {
    set(state => ({ files: state.files.filter(f => f.fileId !== fileId) }));
    try {
      await fetch(`/api/copilot/files/${fileId}`, { method: 'DELETE' });
    } catch (error) {
      console.error('library:deleteFile error', error);
    }
  },
  addLocalChat: (sessionId, title) => {
    set(state => {
      if (state.chats.some(c => c.sessionId === sessionId)) return {};
      const now = new Date().toISOString();
      return {
        chats: [
          { type: 'chat' as const, sessionId, title, createdAt: now, updatedAt: now, collected: false },
          ...state.chats,
        ],
      };
    });
  },
}));

export function useAllItems(): AllItem[] {
  const { chats, files } = useLibraryStore();
  return useMemo(
    () =>
      [...chats, ...files].sort((a, b) => {
        return (
          new Date(b.updatedAt ?? b.createdAt).getTime() -
          new Date(a.updatedAt ?? a.createdAt).getTime()
        );
      }),
    [chats, files]
  );
}
