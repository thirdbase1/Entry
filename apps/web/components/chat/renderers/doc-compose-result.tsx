'use client';

/**
 * Ported from pages/chats/renderers/chat-content-stream-objects.tsx's
 * actual dispatch (NOT doc-compose-result.tsx, which — confirmed via
 * repo-wide grep — is dead code in the original, never imported
 * anywhere). The real live behavior for both `doc_compose` and
 * `make_it_real` tool-results is the exact same simple clickable
 * MakeItRealResult card (GenericToolResult, PageIcon, title, onClick, NO
 * content preview/copy button) — mirrored here 1:1, and the running state
 * uses GeneratingCard with the literal original copy "Generating..." (not
 * "Composing…").
 */
import type { EveDynamicToolPart } from 'eve/react';
import { PageIcon } from '@blocksuite/icons/rc';
import { useOpenDocContext } from '@/contexts/doc-panel-context';
import { GenericToolResult } from './generic-tool-result';
import { GeneratingCard } from './generating-card';

export function DocComposeResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { title?: string; markdown?: string } | undefined;
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
  const title = output?.title ?? input?.title ?? 'Document';

  const handleClick = () => {
    const tempId = 'temp-' + Date.now();
    sessionStorage.setItem(`doc:${tempId}`, JSON.stringify({ content, title }));
    openDoc(tempId);
  };

  return <GenericToolResult icon={<PageIcon />} title={title} onClick={handleClick} />;
}
