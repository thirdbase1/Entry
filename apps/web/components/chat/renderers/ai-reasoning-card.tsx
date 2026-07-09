'use client';

/**
 * Ported from pages/chats/renderers/ai-reasoning-card.tsx — collapsible
 * "Thinking… Ns" / "Thought for Ns" header over the reasoning text.
 * Simplified from the original: no fake progressive-typing simulation
 * (that existed because the original's GraphQL layer delivered full
 * reasoning text in one shot; eve streams real reasoning deltas token by
 * token already, so the real streaming IS the progressive effect —
 * faking a second one on top would double up).
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export function AIReasoningCard({ text, loading = false }: { text: string; loading?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
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

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
      >
        {loading && <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />}
        <span className="font-medium text-foreground">
          {loading ? `Thinking… ${elapsed}s` : `Thought for ${elapsed || ''}${elapsed ? 's' : ''}`.trim()}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn('ml-auto text-muted-foreground transition-transform', expanded && 'rotate-180')}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {(expanded || loading) && (
        <div ref={contentRef} className="px-3 pb-3 text-xs text-muted-foreground max-h-40 overflow-y-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
