'use client';

/**
 * Ported 1:1 from pages/chats/renderers/web-search-result.tsx. Restored the
 * real shell (GenericToolResult: rounded-2xl, h-14 header, expand icon,
 * height-animated content) and the real result-row layout: favicon (with
 * Google favicon-service fallback + graceful hide-on-error), linked title,
 * snippet, an optional gray content-preview box (truncated to 500 chars),
 * and the URL — all results shown in a scrollable max-h list, not sliced to
 * a handful. Title copy matches the original exactly ("The search is
 * complete, and these webpages have been searched") with the count shown
 * next to it, always-on (not swapped for a "Searching…" placeholder — the
 * original's isRunning/streaming call state uses a separate GenericToolCalling
 * card upstream in chat-content-stream-objects, this component only ever
 * renders once results exist).
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useMemo } from 'react';
import { WebIcon } from '@blocksuite/icons/rc';
import { GenericToolResult } from './generic-tool-result';
import { GenericToolCalling } from './generic-tool-calling';

interface SearchResultItem {
  title?: string;
  name?: string;
  url?: string;
  link?: string;
  snippet?: string;
  description?: string;
  text?: string;
  favicon?: string;
  content?: string;
  body?: string;
  fullText?: string;
}

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  favicon?: string;
}

function useWebResult(results: SearchResultItem[]) {
  return useMemo<ParsedResult[]>(() => {
    if (!Array.isArray(results)) return [];
    return results.map(result => ({
      title: result.title || result.name || 'Untitled',
      url: result.url || result.link || '#',
      snippet: result.snippet || result.description || result.text || '',
      content: result.content || result.body || result.fullText || '',
      favicon:
        result.favicon ||
        (() => {
          try {
            const domain = new URL(result.url || result.link || 'https://example.com').hostname;
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
          } catch {
            return undefined;
          }
        })(),
    }));
  }, [results]);
}

export function WebSearchResult({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { results?: SearchResultItem[] } | undefined) : undefined;
  const rawResults = output?.results ?? [];
  const searchResults = useWebResult(rawResults);
  const resultCount = searchResults.length;

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<WebIcon />} title="Web search failed">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  if (part.state === 'input-streaming' || part.state === 'input-available') {
    const input = part.input as { query?: string } | undefined;
    return (
      <GenericToolCalling title={input?.query ? `Searching the web for "${input.query}"` : 'Searching the web'} />
    );
  }

  return (
    <GenericToolResult
      icon={<WebIcon />}
      title="The search is complete, and these webpages have been searched"
      count={resultCount}
    >
      {searchResults.length > 0 ? (
        <div className="py-3 px-4.5 max-h-150 overflow-y-auto">
          {searchResults.map((result, index) => (
            <div key={index} className="flex items-start gap-3 rounded">
              <div className="flex-shrink-0 mt-0.5 h-4 flex items-center">
                {result.favicon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.favicon}
                    alt=""
                    className="w-4 h-4"
                    onError={e => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    <path d="M2 12h20" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate mb-2">
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary transition-colors"
                  >
                    {result.title}
                  </a>
                </div>
                {result.snippet && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.snippet}</p>
                )}
                {result.content && (
                  <div className="p-2 bg-muted rounded text-xs text-muted-foreground max-h-32 overflow-y-auto">
                    <div className="whitespace-pre-wrap line-clamp-6">
                      {result.content.length > 500 ? result.content.substring(0, 500) + '...' : result.content}
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground/70 mt-1 truncate">{result.url}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-3 text-sm text-muted-foreground text-center">No search results found.</div>
      )}
    </GenericToolResult>
  );
}
