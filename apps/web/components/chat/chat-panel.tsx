'use client';

/**
 * Ported 1:1 from components/chat-panel/chat-panel.tsx.
 *
 * A chat panel scoped to a specific document — opened from DocPanel's
 * "chat about this doc" button. Renders a fresh ChatInterface with the
 * doc pre-attached as context (via eve's clientContext, see chat-context.tsx),
 * so the first message onward already has the doc's content available
 * to the model without the user manually attaching it.
 */
import { useMemo } from 'react';
import { ChatInterface } from '@/components/chat/chat-interface';
import { useLibraryStore } from '@/store/library';

export function ChatPanel({ docId }: { docId?: string }) {
  const docs = useLibraryStore(s => s.docs);

  const initialAttachedContext = useMemo(() => {
    if (!docId) return undefined;
    const doc = docs.find(d => d.docId === docId);
    return [
      {
        type: 'doc' as const,
        id: docId,
        label: doc?.title ?? 'This document',
      },
    ];
  }, [docId, docs]);

  return (
    <ChatInterface
      placeholderTitle="Ask about this document"
      placeholder="What would you like to know?"
      initialAttachedContext={initialAttachedContext}
    />
  );
}
