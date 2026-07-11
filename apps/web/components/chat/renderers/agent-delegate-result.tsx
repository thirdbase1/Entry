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
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {part.errorText}
      </div>
    );
  }

  const output = part.state === 'output-available' ? (part.output as AgentDelegateOutput | undefined) : undefined;

  if (output?.error) {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-4 text-sm text-destructive">
        {output.error}
      </div>
    );
  }

  const modelUsed = output?.modelUsed ?? 'unknown model';
  const result = output?.result ?? '';

  return (
    <GenericToolResult icon={<GroupIcon />} title={`Delegated to ${modelUsed}`}>
      <div className="px-4 py-3 max-h-150 overflow-y-auto">
        {output?.note && <div className="text-xs text-muted-foreground mb-2 italic">{output.note}</div>}
        <MarkdownText text={result} className="prose prose-sm text-[13px] text-muted-foreground" />
      </div>
    </GenericToolResult>
  );
}
