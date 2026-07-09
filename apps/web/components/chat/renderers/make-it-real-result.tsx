'use client';

/**
 * Ported from pages/chats/renderers/make-it-real-result.tsx. Reuses the
 * same DocCard the doc_compose renderer uses (original also reused
 * MakeItRealResult for both doc_compose AND make_it_real results — see
 * chat-content-stream-objects.tsx's dispatch, both hit the same
 * component) — kept that sharing here as DocCard too, just a distinct
 * description string to tell the two apart.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { DocCard } from '@/components/doc-panel/doc-card';
import { GeneratingCard } from './generating-card';

export function MakeItRealResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { markdown?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { content?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning) {
    return <GeneratingCard title="Making it real…" content={input?.markdown} />;
  }

  if (part.state === 'output-error') {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {part.errorText}
      </div>
    );
  }

  const content = output?.content ?? input?.markdown ?? '';
  return <DocCard content={content} title="Redesigned document" description="Click to open in the doc editor" />;
}
