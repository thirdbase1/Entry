'use client';

/**
 * Ported 1:1 from pages/chats/renderers/task-analysis-card.tsx — same
 * GenericToolResult shell as ai-reasoning-card.tsx, ThinkingIcon, static
 * "Task Analysis" title, content = reasoning + suggestedApproach joined by
 * a blank line. Adapted field names for eve's task_analysis tool output
 * (plan/summary) mapped onto the original's reasoning/suggestedApproach
 * slots — reasoning <- summary, suggestedApproach <- plan steps joined as
 * a numbered markdown list (closest equivalent content shape).
 */
import type { EveDynamicToolPart } from 'eve/react';
import { ThinkingIcon } from '@blocksuite/icons/rc';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolResult } from './generic-tool-result';
import { GenericToolCalling } from './generic-tool-calling';

export function TaskAnalysisCard({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { plan?: string[]; summary?: string; reasoning?: string; suggestedApproach?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  if (isRunning || !output) {
    return <GenericToolCalling icon={<ThinkingIcon />} title="Calling task_analysis …" />;
  }

  const reasoning = output.reasoning ?? output.summary ?? '';
  const approach = output.suggestedApproach ?? (output.plan?.length ? output.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') : '');
  const text = [reasoning, approach].filter(Boolean).join('\n\n');

  return (
    <GenericToolResult icon={<ThinkingIcon />} title={<span className="text-sm font-medium">Task Analysis</span>}>
      <div className="px-4 max-h-150 overflow-y-auto">
        <div className="max-w-none my-2">
          <MarkdownText text={text} className="prose prose-sm text-[13px] text-muted-foreground" />
        </div>
      </div>
    </GenericToolResult>
  );
}
