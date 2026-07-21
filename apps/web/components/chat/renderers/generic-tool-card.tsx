'use client';

/**
 * Ported 1:1 from the "Default tool result display" branch of
 * chat-content-stream-objects.tsx (the original's fallback for any
 * tool-result without a dedicated renderer): GenericToolResult shell,
 * CheckBoxCheckSolidIcon, title `${toolName} result` using the RAW
 * tool name (confirmed against the original — it does NOT humanize/
 * title-case the name, e.g. "web_search_cloudsway result" verbatim), body
 * = a JSON.stringify <pre> block. Running state reuses the shared
 * GenericToolCalling ticking-timer placeholder with the same raw-name
 * title format: `Calling ${toolName} ...`.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { CheckBoxCheckSolidIcon } from '@blocksuite/icons/rc';
import { GenericToolResult } from './generic-tool-result';
import { isTimeoutError } from '@/components/ui/tool';
import { GenericToolCalling } from './generic-tool-calling';

export function GenericToolCard({ part }: { part: EveDynamicToolPart }) {
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning) {
    return <GenericToolCalling title={`Calling ${name} …`} />;
  }

  if (part.state === 'output-error') {
    const timedOut = isTimeoutError(part.errorText);
    return (
      <GenericToolResult
        icon={<CheckBoxCheckSolidIcon />}
        title={timedOut ? `${name} timed out` : `${name} failed`}
        status="output-error"
        errorText={part.errorText}
        autoCollapseOnTerminal
      >
        <div className={`p-3 text-sm ${timedOut ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}`}>{part.errorText}</div>
      </GenericToolResult>
    );
  }

  return (
    <GenericToolResult icon={<CheckBoxCheckSolidIcon />} title={`${name} result`} autoCollapseOnTerminal>
      <pre className="whitespace-pre-wrap break-all text-xs max-h-48 overflow-auto p-3">
        {JSON.stringify(part.output, null, 2)}
      </pre>
    </GenericToolResult>
  );
}
