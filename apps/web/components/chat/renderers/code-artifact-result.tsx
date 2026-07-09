'use client';

import type { EveDynamicToolPart } from 'eve/react';
import { CodeIcon } from '@blocksuite/icons/rc';
import { useState } from 'react';

export function CodeArtifactResult({ part }: { part: EveDynamicToolPart }) {
  const [showCode, setShowCode] = useState(false);
  const input = part.input as { code?: string; language?: string; title?: string } | undefined;
  const output = part.state === 'output-available' ? (part.output as { previewUrl?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <CodeIcon className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {input?.title || 'Code Artifact'}
        </span>
        {isRunning && <span className="text-xs text-muted-foreground ml-auto animate-pulse">Generating…</span>}
        {!isRunning && (
          <button
            onClick={() => setShowCode(s => !s)}
            className="text-xs text-muted-foreground ml-auto hover:text-foreground transition-colors"
          >
            {showCode ? 'Hide code' : 'Show code'}
          </button>
        )}
      </div>
      {part.state === 'output-error' && (
        <div className="p-3 text-xs text-destructive">{part.errorText}</div>
      )}
      {showCode && input?.code && (
        <pre className="p-3 text-xs overflow-x-auto bg-muted text-foreground">{input.code}</pre>
      )}
      {output?.previewUrl && (
        <iframe
          src={output.previewUrl}
          className="w-full h-96 border-0"
          sandbox="allow-scripts"
          title="Code artifact preview"
        />
      )}
    </div>
  );
}
