'use client';

/**
 * Ported 1:1 from pages/chats/renderers/web-search-result.tsx. Restored the
 * real result-row layout: favicon (with Google favicon-service fallback +
 * graceful hide-on-error), linked title, snippet, an optional gray
 * content-preview box (truncated to 500 chars), and the URL — all results
 * shown in a scrollable max-h list, not sliced to a handful.
 *
 * FIXED (2026-07-11) — real, confirmed bug, not a display-polish thing:
 * the actual `web_search` tool-impl (apps/agent/agent/lib/tool-impls/
 * web_search.ts) returns a bare ARRAY (`result.results.map(...)`) as its
 * whole output. This component was reading `part.output.results` — an
 * object-wrapper shape that never existed — so `rawResults` was `[]`
 * on every single real search, no matter how many results Parallel
 * actually found. The card rendered and *expanded* fine; it just always
 * showed "No search results found" underneath. Also: the real tool output
 * only ever has `{title, url, content, publishedDate}` — no `snippet`,
 * `name`/`link`, or `favicon` field ever comes back from it — so the old
 * `result.snippet || result.description || result.text` chain always fell
 * through to `undefined` too. Now derives a short snippet from `content`
 * (first ~200 chars) so the preview line actually has something in it,
 * while the full `content` remains available in the expandable box below.
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
    return results.map(result => {
      const content = result.content || result.body || result.fullText || '';
      const snippet =
        result.snippet ||
        result.description ||
        result.text ||
        // Parallel's real output has no separate snippet field, only
        // `content` — derive a short preview from it rather than showing
        // a blank line for every real search result.
        (content ? content.slice(0, 200) + (content.length > 200 ? '...' : '') : '');
      return {
        title: result.title || result.name || 'Untitled',
        url: result.url || result.link || '#',
        snippet,
        content,
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
      };
    });
  }, [results]);
}

export function WebSearchResult({ part }: { part: EveDynamicToolPart }) {
  const output =
    part.state === 'output-available'
      ? (part.output as SearchResultItem[] | { results?: SearchResultItem[] } | undefined)
      : undefined;
  // Real tool output is a bare array; also accept a `{results: [...]}`
  // wrapper defensively in case that ever changes upstream.
  const rawResults = Array.isArray(output) ? output : (output?.results ?? []);
  const searchResults = useWebResult(rawResults);
  const resultCount = searchResults.length;

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<WebIcon />} title="Web search failed" status="output-error">
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
