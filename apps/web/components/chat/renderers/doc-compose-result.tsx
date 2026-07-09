'use client';

import type { EveDynamicToolPart } from 'eve/react';
import { InlineDocPanel } from '@/components/doc-panel/doc-panel';
import { DocCard } from '@/components/doc-panel/doc-card';
import { GeneratingCard } from './generating-card';

export function DocComposeResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { title?: string; markdown?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { content?: string; title?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning) {
    return <GeneratingCard title={input?.title ? `Composing "${input.title}"…` : 'Composing document…'} content={input?.markdown} />;
  }

  if (part.state === 'output-error') {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {part.errorText}
      </div>
    );
  }

  const content = output?.content ?? input?.markdown ?? '';
  const title = output?.title ?? input?.title ?? 'Document';

  return <DocCard content={content} title={title} description="Click to open in the doc editor" />;
}
