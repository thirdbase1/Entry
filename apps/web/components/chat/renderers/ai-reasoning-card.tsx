'use client';

/**
 * Rebuilt 2026-07-11 per explicit user request ("I don't like the way it
 * uses card... just show brain 🧠, I can click it to expand"): dropped the
 * shared `GenericToolResult` card shell entirely (rounded-2xl box,
 * box-shadow, h-14 header bar) in favor of one plain inline row -- a brain
 * emoji + a one-line status ("Thinking… Ns" / "Thought for Ns" / "Thoughts")
 * that's just a bare `<button>`, no border/background/shadow at all. Click
 * toggles a plain expanded text block underneath (left border rule instead
 * of a boxed card, same as how the rest of this app already treats
 * secondary/quiet content). Auto-expands live while streaming (`loading`)
 * exactly like the old card did, and a manual click at any point still
 * opts the user out of that auto-behavior for the rest of this turn --
 * same auto-expand contract as before, just a different shell.
 */
import { useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@/components/ui/markdown';
import { cn } from '@/lib/utils';

export function AIReasoningCard({ text, loading = false }: { text: string; loading?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
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

  // Auto-open while streaming (unless the user already manually chose a
  // state this turn), same as the old card's `autoExpand={loading}`.
  const expanded = manuallyToggled ?? loading;

  const label = loading ? `Thinking… ${elapsed}s` : elapsed > 0 ? `Thought for ${elapsed}s` : 'Thoughts';

  return (
    <div className="flex flex-col gap-1 w-full">
      <button
        type="button"
        onClick={() => setManuallyToggled(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className={cn('text-base leading-none', loading && 'animate-pulse')} aria-hidden="true">
          🧠
        </span>
        <span className="font-medium">{label}</span>
      </button>

      {expanded && (
        <div ref={contentRef} className="pl-5 border-l-2 border-muted ml-1.5 max-h-150 overflow-y-auto">
          <MarkdownText text={text} loading={loading} className="prose prose-sm text-[13px] text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
