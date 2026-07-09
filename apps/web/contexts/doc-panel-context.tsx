'use client';

import { createContext, type ReactNode, useContext, useState, useCallback } from 'react';

export type OpenDocContextType = {
  openDoc: (docId: string) => void;
  closeDoc: () => void;
  activeDocId: string | null;
};

const OpenDocContext = createContext<OpenDocContextType | null>(null);

export function useOpenDocContext() {
  const context = useContext(OpenDocContext);
  if (!context) {
    throw new Error('useOpenDocContext must be used within a OpenDocProvider');
  }
  return context;
}

export interface OpenDocProviderProps {
  children: ReactNode;
}

export function OpenDocProvider({ children }: OpenDocProviderProps) {
  const [activeDocId, setActiveDocId] = useState<string | null>(null);

  const openDoc = useCallback((docId: string) => {
    setActiveDocId(docId);
  }, []);

  const closeDoc = useCallback(() => {
    setActiveDocId(null);
  }, []);

  return (
    <OpenDocContext.Provider value={{ openDoc, closeDoc, activeDocId }}>
      {children}
    </OpenDocContext.Provider>
  );
}
