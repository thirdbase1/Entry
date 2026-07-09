'use client';

/**
 * Ported from pages/chats/renderers/python-code-result.tsx +
 * e2b-python-result.tsx merged into one — under eve, the original's two
 * separate tools (`python_coding` = draft-only, `e2b_python_sandbox` =
 * execute) collapsed to just `python_coding` (draft/generate) since
 * eve's built-in `bash` tool already covers real execution in the
 * sandbox (see agent/tools/python_coding.ts's own header comment). This
 * renderer only needs the drafting shape: `{code, explanation}`.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useState } from 'react';

export function PythonCodeResult({ part }: { part: EveDynamicToolPart }) {
  const [showCode, setShowCode] = useState(true);
  const output = part.state === 'output-available' ? (part.output as { code?: string; explanation?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="rounded-lg border border-border bg-card w-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        <span className="text-sm font-medium text-foreground">Python code</span>
        {isRunning && <span className="text-xs text-muted-foreground ml-auto animate-pulse">Writing…</span>}
        {!isRunning && output?.code && (
          <button onClick={() => setShowCode(s => !s)} className="text-xs text-muted-foreground ml-auto hover:text-foreground transition-colors">
            {showCode ? 'Hide code' : 'Show code'}
          </button>
        )}
      </div>
      {part.state === 'output-error' && (
        <div className="p-3 text-xs text-destructive">{part.errorText}</div>
      )}
      {output?.explanation && (
        <div className="px-3 pt-3 text-sm text-muted-foreground">{output.explanation}</div>
      )}
      {showCode && output?.code && (
        <pre className="p-3 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto text-foreground bg-muted/50">
          <code>{output.code}</code>
        </pre>
      )}
    </div>
  );
}
