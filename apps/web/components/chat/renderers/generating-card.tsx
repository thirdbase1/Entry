'use client';

/**
 * Ported from pages/chats/renderers/generating-card.tsx +
 * generating-card.css.ts — shared "streaming preview" shell used while
 * doc_compose/make_it_real/python_coding are still producing partial
 * content (`input-streaming` state). The original's CSS-in-JS mask
 * gradient (fade top+bottom over the scrolling preview) is reproduced
 * with a plain Tailwind `mask-image` utility via arbitrary value, since
 * vanilla-extract isn't used in this app (see snapshot-helper.ts's sibling
 * decision — CSS Modules/Tailwind chosen for Turbopack stability).
 */
import { useEffect, useRef } from 'react';

export function GeneratingCard({
  title,
  icon,
  content,
}: {
  title?: string;
  icon?: React.ReactNode;
  content?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: contentRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [content]);

  return (
    <div className="rounded-xl border border-border bg-card w-full p-4">
      <header className="flex items-center gap-2">
        {icon ?? <span className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />}
        {title && <div className="text-sm font-medium text-foreground truncate flex-1">{title}</div>}
      </header>
      {content && (
        <div
          ref={contentRef}
          className="mt-3 max-h-20 overflow-hidden text-xs text-muted-foreground leading-5 whitespace-pre-wrap"
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 50%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 50%, transparent 100%)' }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
