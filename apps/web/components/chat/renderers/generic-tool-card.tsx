'use client';

import type { EveDynamicToolPart } from 'eve/react';
import { useState } from 'react';

function humanizeToolName(name: string) {
  return name
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Fallback card for any tool call that doesn't have a dedicated renderer. */
export function GenericToolCard({ part }: { part: EveDynamicToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const isError = part.state === 'output-error';

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
      >
        <span
          className={
            isRunning
              ? 'w-2 h-2 rounded-full bg-primary animate-pulse'
              : isError
                ? 'w-2 h-2 rounded-full bg-destructive'
                : 'w-2 h-2 rounded-full bg-muted-foreground'
          }
        />
        <span className="font-medium text-foreground">{humanizeToolName(name)}</span>
        <span className="text-muted-foreground text-xs ml-auto">
          {isRunning ? 'Running…' : isError ? 'Failed' : 'Done'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-xs text-muted-foreground space-y-2">
          {part.input !== undefined && (
            <div>
              <div className="font-medium mb-1">Input</div>
              <pre className="bg-muted rounded p-2 overflow-x-auto">{JSON.stringify(part.input, null, 2)}</pre>
            </div>
          )}
          {part.state === 'output-available' && (
            <div>
              <div className="font-medium mb-1">Output</div>
              <pre className="bg-muted rounded p-2 overflow-x-auto">{JSON.stringify(part.output, null, 2)}</pre>
            </div>
          )}
          {part.state === 'output-error' && (
            <div className="text-destructive">{part.errorText}</div>
          )}
        </div>
      )}
    </div>
  );
}
