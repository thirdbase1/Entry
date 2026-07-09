'use client';

/**
 * Ported 1:1 from pages/chats/renderers/make-it-real-result.tsx — original
 * is deliberately simpler than doc-compose-result/DocCard: just the shared
 * GenericToolResult shell (PageIcon, title, no content preview, no copy
 * button), clickable to open the doc panel. Previously this reused
 * DocCard (which adds a content preview + copy button doc-compose has but
 * make-it-real's original never did) — reverted to match the original's
 * actual simpler card.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { PageIcon } from '@blocksuite/icons/rc';
import { useOpenDocContext } from '@/contexts/doc-panel-context';
import { GenericToolResult } from './generic-tool-result';
import { GeneratingCard } from './generating-card';

export function MakeItRealResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { markdown?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { content?: string; title?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const { openDoc } = useOpenDocContext();

  if (isRunning) {
    return <GeneratingCard title="Generating..." content={input?.markdown} />;
  }

  if (part.state === 'output-error') {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {part.errorText}
      </div>
    );
  }

  const content = output?.content ?? input?.markdown ?? '';
  const title = output?.title ?? 'Redesigned document';

  const handleClick = () => {
    const tempId = 'temp-' + Date.now();
    sessionStorage.setItem(`doc:${tempId}`, JSON.stringify({ content, title }));
    openDoc(tempId);
  };

  return <GenericToolResult icon={<PageIcon />} title={title} onClick={handleClick} />;
}
