'use client';

import type { EveDynamicToolPart } from 'eve/react';
import { WebIcon } from '@blocksuite/icons/rc';
import { useState } from 'react';

interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

export function WebSearchResult({ part }: { part: EveDynamicToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const input = part.input as { query?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { results?: SearchResultItem[] } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const results = output?.results ?? [];

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
      >
        <WebIcon className="w-4 h-4 text-muted-foreground" />
        <span className="font-medium text-foreground truncate">
          {isRunning ? 'Searching the web…' : `Searched: ${input?.query ?? ''}`}
        </span>
        {!isRunning && results.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">{results.length} results</span>
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
              <div className="text-sm text-primary truncate">{r.title}</div>
              <div className="text-xs text-muted-foreground truncate">{r.url}</div>
              {r.snippet && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.snippet}</div>}
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
