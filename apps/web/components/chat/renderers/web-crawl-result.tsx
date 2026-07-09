'use client';

/**
 * Ported 1:1 from pages/chats/renderers/web-crawl-result.tsx — reuses the
 * exact same result-list rendering as web-search-result.tsx (the original
 * imports `useWebResult` from the search renderer too), just a different
 * icon (PublishIcon) and title ("Crawling completed").
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useMemo } from 'react';
import { PublishIcon } from '@blocksuite/icons/rc';
import { GenericToolResult } from './generic-tool-result';
import { GenericToolCalling } from './generic-tool-calling';
import { EmbedWebIcon } from '@blocksuite/icons/rc';

interface CrawlResultItem {
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

function useWebResult(results: CrawlResultItem[]) {
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

export function WebCrawlResult({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { results?: CrawlResultItem[] } | undefined) : undefined;
  const rawResults = output?.results ?? [];
  const searchResults = useWebResult(rawResults);
  const resultCount = searchResults.length;

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<PublishIcon />} title="Crawling failed">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  if (part.state === 'input-streaming' || part.state === 'input-available') {
    const input = part.input as { url?: string } | undefined;
    return <GenericToolCalling icon={<EmbedWebIcon />} title={input?.url ? `Crawling "${input.url}"` : 'Crawling'} />;
  }

  return (
    <GenericToolResult icon={<PublishIcon />} title="Crawling completed" count={resultCount}>
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
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                    {result.title}
                  </a>
                </div>
                {result.snippet && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.snippet}</p>}
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
