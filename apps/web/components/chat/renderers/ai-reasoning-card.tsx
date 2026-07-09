'use client';

/**
 * Ported 1:1 from pages/chats/renderers/ai-reasoning-card.tsx. Uses the
 * real shared GenericToolResult shell (rounded-2xl, h-14 header, expand
 * icon toggle, box-shadow, AnimatePresence height animation — collapsed by
 * default like every other tool card in the original) instead of a
 * hand-rolled simplified collapsible. Icon is a spinner only while
 * `loading`, none once finished (matches original: `icon={loading ?
 * <Loading /> : null}`). Title is "Thinking… Ns" while loading, "Thought
 * for Ns" once done, "Thoughts" if there was never a duration — exact
 * original copy/format.
 *
 * Simplified from the original in one intentional way: no fake
 * progressive-typing simulation over the full text (that existed because
 * the original's GraphQL layer delivered full reasoning text in one shot;
 * eve streams real reasoning deltas token by token already, so the real
 * streaming IS the progressive effect — faking a second one on top would
 * double up).
 */
import { useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolResult } from './generic-tool-result';

function Spinner() {
  return <span className="inline-block w-4 h-4 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />;
}

export function AIReasoningCard({ text, loading = false }: { text: string; loading?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    if (loading && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [text, loading]);

  if (!text) return null;

  const statusText = loading ? (
    <div className="flex items-center gap-1">
      <span className="text-sm font-medium">Thinking...</span>
      <span className="text-sm font-normal">{elapsed}s</span>
    </div>
  ) : elapsed > 0 ? (
    <div className="flex items-center gap-1">
      <span className="text-sm font-medium">Thought for</span>
      <span className="text-sm font-normal">{elapsed}s</span>
    </div>
  ) : (
    <div className="flex items-center gap-1">
      <span className="text-sm font-medium">Thoughts</span>
    </div>
  );

  return (
    <GenericToolResult icon={loading ? <Spinner /> : null} title={statusText}>
      <div className="px-4 max-h-150 overflow-y-auto">
        <div ref={contentRef} className="max-w-none my-2">
          <MarkdownText text={text} loading={loading} className="prose prose-sm text-[13px] text-muted-foreground" />
        </div>
      </div>
    </GenericToolResult>
  );
}
