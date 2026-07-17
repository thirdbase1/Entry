'use client';

/**
 * Ported 1:1 from pages/chats/renderers/python-code-result.tsx — the real
 * shell (GenericToolResult, FilePythonIcon, static "Code generated"
 * title, no hide/show toggle — the original just shows the code inside
 * the shell's own expand/collapse). Under eve, the original's two
 * separate tools (`python_coding` = draft-only, `e2b_python_sandbox` =
 * execute) collapsed to just `python_coding` (draft/generate) since eve's
 * built-in `bash` tool already covers real execution in the sandbox (see
 * agent/tools/python_coding.ts's own header comment) — this renderer only
 * needs the drafting shape: `{code, explanation}`.
 *
 * NOTE: the original used a `useHighlightedCode` shiki-based hook for real
 * syntax-highlighted HTML; no syntax highlighter is installed anywhere in
 * this ported app yet (verified — it's a systemic gap across all code
 * rendering, not specific to this component), so this still renders plain
 * monospace text. Flagged as a follow-up, not fixed here to avoid a new
 * heavy dependency in a fast pass.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { FilePythonIcon } from '@/components/icons/file-python';
import { GenericToolResult } from './generic-tool-result';
import { GeneratingCard } from './generating-card';

export function PythonCodeResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as { task?: string } | undefined;
  const output =
    part.state === 'output-available'
      ? (part.output as { code?: string; explanation?: string; truncated?: boolean; note?: string } | undefined)
      : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning || !output?.code) {
    return <GeneratingCard title="Coding..." icon={<FilePythonIcon />} content={input?.task} />;
  }

  if (part.state === 'output-error') {
    return (
      <GenericToolResult title="Code generation failed" icon={<FilePythonIcon />} status="output-error">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  return (
    <GenericToolResult title={output.truncated ? 'Code generated (incomplete)' : 'Code generated'} icon={<FilePythonIcon />}>
      {output.truncated && (
        <div className="mx-4 mt-3 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <span className="shrink-0">⚠️</span>
          <span>{output.note ?? 'Output was cut off by the token limit before finishing — this script is likely incomplete.'}</span>
        </div>
      )}
      {output.explanation && (
        <div className="px-4 pt-3 text-sm text-muted-foreground">{output.explanation}</div>
      )}
      <div className="not-prose max-h-150 overflow-y-auto px-10 py-4 text-xs">
        <pre className="whitespace-pre-wrap font-mono">{output.code}</pre>
      </div>
    </GenericToolResult>
  );
}
