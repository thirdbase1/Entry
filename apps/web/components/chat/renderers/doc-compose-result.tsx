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
 *
 * FIXED (2026-07-11) — real, confirmed bug: the actual `doc_compose`
 * tool-impl (apps/agent/agent/lib/tool-impls/doc_compose.ts) returns
 * `{docId, title, markdown, wordCount}` — this was reading `output.content`
 * (field never existed) with a fallback to `input.markdown` (also never
 * existed — doc_compose's real input schema is `{title, userPrompt}`, no
 * `markdown` field). Net effect: clicking this card opened a completely
 * BLANK document, silently discarding the real generated content that
 * genuinely exists server-side in `output.markdown`. Now reads the real
 * field names on both sides.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { PageIcon } from '@blocksuite/icons/rc';
import { useOpenDocContext } from '@/contexts/doc-panel-context';
import { GenericToolResult } from './generic-tool-result';
import { GeneratingCard } from './generating-card';

export function DocComposeResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { title?: string; userPrompt?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { markdown?: string; title?: string; docId?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const { openDoc } = useOpenDocContext();

  if (isRunning) {
    // No partial content available during generation (doc_compose uses a
    // single blocking generateText call, no incremental streaming) — show
    // the user's original ask as context instead of nothing.
    return <GeneratingCard title="Generating..." content={input?.userPrompt} />;
  }

  if (part.state === 'output-error') {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {part.errorText}
      </div>
    );
  }

  const content = output?.markdown ?? '';
  const title = output?.title ?? input?.title ?? 'Document';

  const handleClick = () => {
    // FIXED (2026-07-11): same real bug as make-it-real-result.tsx — the
    // tool already persists this via addDoc() and returns a real docId;
    // use it instead of an ephemeral sessionStorage-only copy so the doc
    // is still reachable after the tab/session ends.
    if (output?.docId) {
      openDoc(output.docId);
      return;
    }
    const tempId = 'temp-' + Date.now();
    sessionStorage.setItem(`doc:${tempId}`, JSON.stringify({ content, title }));
    openDoc(tempId);
  };

  return <GenericToolResult icon={<PageIcon />} title={title} onClick={handleClick} />;
}
