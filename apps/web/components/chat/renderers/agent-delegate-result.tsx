'use client';

/**
 * Renders the `agent` tool — real sub-agent delegation, optionally to an
 * explicit provider/model (see apps/agent/agent/lib/tool-impls/agent.ts).
 * Same minimal plain-line shell as every other tool card (GenericToolResult/
 * GenericToolCalling — no box/border/shadow), but the whole point of this
 * card is to make the ACTUAL model that ran fully visible: title always
 * shows "Delegated to <model>" using the real `modelUsed` the tool
 * returned, never just the model the caller *asked* for, so a fallback
 * (e.g. BYOK note, or a provider auto-pick) is never hidden from the user.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { GroupIcon } from '@blocksuite/icons/rc';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolResult } from './generic-tool-result';
import { GenericToolCalling } from './generic-tool-calling';

interface AgentDelegateInput {
  message?: string;
  provider?: string;
  model?: string;
}

interface AgentDelegateOutput {
  result?: string;
  modelUsed?: string;
  stepsTaken?: number;
  truncated?: boolean;
  note?: string;
  error?: string;
}

export function AgentDelegateResult({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as AgentDelegateInput | undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning) {
    const askedFor = input?.model ?? input?.provider;
    return <GenericToolCalling icon={<GroupIcon />} title={askedFor ? `Delegating to ${askedFor}…` : 'Delegating to a sub-agent…'} />;
  }

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<GroupIcon />} title="Delegation failed" status="output-error">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  const output = part.state === 'output-available' ? (part.output as AgentDelegateOutput | undefined) : undefined;

  if (output?.error) {
    return (
      <GenericToolResult icon={<GroupIcon />} title="Delegation failed" status="output-error">
        <div className="p-3 text-sm text-destructive">{output.error}</div>
      </GenericToolResult>
    );
  }

  const modelUsed = output?.modelUsed ?? 'unknown model';
  const result = output?.result ?? '';
  const truncated = output?.truncated ?? false;
  const stepsTaken = output?.stepsTaken;

  // Long-task visibility: a delegated subtask that ran out of its step
  // budget before the model itself decided it was done looks identical
  // to a genuinely finished one unless flagged -- this banner is that
  // flag, so it's obvious at a glance the result below is partial
  // progress, not a final answer (see tool-impls/agent.ts's
  // isTruncatedFinish for how this is detected).
  return (
    <GenericToolResult
      icon={<GroupIcon />}
      title={`Delegated to ${modelUsed}${stepsTaken ? ` · ${stepsTaken} step${stepsTaken === 1 ? '' : 's'}` : ''}`}
    >
      <div className="px-4 py-3 max-h-150 overflow-y-auto">
        {truncated && (
          <div className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400 mb-2">
            <span className="shrink-0">⚠️</span>
            <span>Ran out of its step budget before finishing on its own — this is partial progress, not a final answer.</span>
          </div>
        )}
        {output?.note && <div className="text-xs text-muted-foreground mb-2 italic">{output.note}</div>}
        <MarkdownText text={result} className="prose prose-sm text-[13px] text-muted-foreground" />
      </div>
    </GenericToolResult>
  );
}
