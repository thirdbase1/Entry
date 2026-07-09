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

export interface Doc extends GenericLibraryMetadata {
  docId: string;
  title: string;
  content: string | null;
  createdAt: string;
  updatedAt: string;
  type: 'doc';
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

export type AllItem = Chat | Doc | FileItem;

export interface LibraryState {
  chats: Chat[];
  docs: Doc[];
  files: FileItem[];
  loading: boolean;
  initialized: boolean;
  refresh: () => Promise<void>;
  toggleCollect: (type: 'chat' | 'doc' | 'file', id: string) => Promise<void>;
  deleteChat: (sessionId: string) => Promise<void>;
  deleteDoc: (docId: string) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  loading: false,
  initialized: false,
  chats: [],
  docs: [],
  files: [],
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });

    try {
      const [chatsRes, docsRes, filesRes] = await Promise.all([
        fetch('/api/chats').then(r => r.json()).catch(() => ({ sessions: [] })),
        fetch('/api/copilot/docs').then(r => r.json()).catch(() => ({ docs: [] })),
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

      const docs: Doc[] = (docsRes.docs || []).map((d: any) => ({
        type: 'doc' as const,
        docId: d.id,
        title: d.title || 'Untitled',
        content: d.content || null,
        createdAt: d.created_date,
        updatedAt: d.updated_date,
        collected: d.collected || false,
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

      set({ chats, docs, files, loading: false, initialized: true });
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
      if (type === 'doc') {
        return { docs: state.docs.map(d => d.docId === id ? { ...d, collected: !d.collected } : d) };
      }
      if (type === 'file') {
        return { files: state.files.map(f => f.fileId === id ? { ...f, collected: !f.collected } : f) };
      }
      return {};
    });

    try {
      if (type === 'doc') {
        await fetch(`/api/copilot/docs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collected: !get().docs.find(d => d.docId === id)?.collected }),
        });
      }
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
  deleteDoc: async (docId) => {
    set(state => ({ docs: state.docs.filter(d => d.docId !== docId) }));
    try {
      await fetch(`/api/copilot/docs/${docId}`, { method: 'DELETE' });
    } catch (error) {
      console.error('library:deleteDoc error', error);
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
}));

export function useAllItems(): AllItem[] {
  const { docs, chats, files } = useLibraryStore();
  return useMemo(
    () =>
      [...chats, ...docs, ...files].sort((a, b) => {
        return (
          new Date(b.updatedAt ?? b.createdAt).getTime() -
          new Date(a.updatedAt ?? a.createdAt).getTime()
        );
      }),
    [chats, docs, files]
  );
}
