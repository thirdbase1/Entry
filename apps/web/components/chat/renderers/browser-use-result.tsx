'use client';

import type { EveDynamicToolPart } from 'eve/react';

export function BrowserUseResult({ part, isStreaming }: { part: EveDynamicToolPart; isStreaming?: boolean }) {
  const input = part.input as { task?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { screenshotUrl?: string; summary?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M2 8h20" />
        </svg>
        <span className="text-sm font-medium text-foreground truncate">
          {isRunning || isStreaming ? 'Browsing…' : 'Browser session'}
        </span>
      </div>
      {input?.task && (
        <div className="px-3 pt-2 text-xs text-muted-foreground">{input.task}</div>
      )}
      {output?.screenshotUrl && (
        <img src={output.screenshotUrl} alt="Browser screenshot" className="w-full border-t border-border" />
      )}
      {output?.summary && (
        <div className="p-3 text-sm text-foreground">{output.summary}</div>
      )}
      {part.state === 'output-error' && (
        <div className="p-3 text-xs text-destructive">{part.errorText}</div>
      )}
    </div>
  );
}
