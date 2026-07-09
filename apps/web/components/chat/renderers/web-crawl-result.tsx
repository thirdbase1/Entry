'use client';

/**
 * Ported from pages/chats/renderers/web-crawl-result.tsx — visually
 * identical shell to web-search-result.tsx (same `useWebResult` shared
 * logic in the original), just a different header/icon. Maps to the
 * apps/agent `web_crawl` tool (packages/ai/src/tools/web-crawl.ts's
 * ported successor — see agent/tools/web_crawl.ts).
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useState } from 'react';

interface CrawlResultItem {
  title?: string;
  url?: string;
  content?: string;
}

export function WebCrawlResult({ part }: { part: EveDynamicToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const input = part.input as { url?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { results?: CrawlResultItem[] } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const results = output?.results ?? [];

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground shrink-0">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" />
        </svg>
        <span className="font-medium text-foreground truncate">
          {isRunning ? `Crawling "${input?.url ?? ''}"` : 'Crawling completed'}
        </span>
        {!isRunning && results.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">{results.length} pages</span>
        )}
      </button>
      {expanded && results.length > 0 && (
        <div className="px-3 pb-3 space-y-2">
          {results.slice(0, 8).map((r, i) => (
            <a
              key={i}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-2 rounded hover:bg-accent transition-colors"
            >
              <div className="text-sm text-primary truncate">{r.title ?? r.url}</div>
              {r.content && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.content}</div>}
            </a>
          ))}
        </div>
      )}
      {part.state === 'output-error' && (
        <div className="px-3 pb-3 text-xs text-destructive">{part.errorText}</div>
      )}
    </div>
  );
}
