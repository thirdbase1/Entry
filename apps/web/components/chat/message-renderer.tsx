'use client';

import type { EveDynamicToolPart, EveMessage, EveMessagePart } from 'eve/react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolCard } from './renderers/generic-tool-card';
import { CodeArtifactResult } from './renderers/code-artifact-result';
import { WebSearchResult } from './renderers/web-search-result';
import { WebCrawlResult } from './renderers/web-crawl-result';
import { BrowserUseResult } from './renderers/browser-use-result';
import { TaskAnalysisCard } from './renderers/task-analysis-card';
import { AuthorizationCard } from './renderers/authorization-card';
import { AIReasoningCard } from './renderers/ai-reasoning-card';
import { ChooseResult } from './renderers/choose-result';
import { TodoListResult } from './renderers/todo-list-result';
import { PythonCodeResult } from './renderers/python-code-result';
import { AgentDelegateResult } from './renderers/agent-delegate-result';
import { IntegrationConnectCard } from './renderers/integration-connect-card';
import { getKnownService } from '@/lib/integration-services';

interface MessageRendererProps {
  message: { id: string; role: 'user' | 'assistant'; parts: readonly EveMessagePart[] };
  isStreaming?: boolean;
  /** Full session history + a sender — needed by `choose` to detect its own answer and submit new ones. */
  allMessages?: readonly EveMessage[];
  onSend?: (text: string) => void;
}

/** Finds the answer to a `choose` prompt by scanning later user messages for a matching option (same heuristic the original used). */
function findChooseAnswer(allMessages: readonly EveMessage[] | undefined, toolCallId: string, options: string[]): string[] {
  if (!allMessages) return [];
  const toolMsgIdx = allMessages.findIndex(m => m.parts.some(p => p.type === 'dynamic-tool' && p.toolCallId === toolCallId));
  if (toolMsgIdx === -1) return [];
  for (let i = toolMsgIdx + 1; i < allMessages.length; i++) {
    const m = allMessages[i];
    if (m.role !== 'user') continue;
    const text = m.parts.filter((p): p is Extract<EveMessagePart, { type: 'text' }> => p.type === 'text').map(p => p.text).join('');
    const matched = options.filter(o => text.includes(o));
    if (matched.length) return text.split(', ');
  }
  return [];
}

/** Scans later user messages for this card's own auto-sent "Connected
 *  X." / "skip" text (see integration-connect-card.tsx's onSend calls)
 *  so a fresh mount after an OAuth redirect round trip shows "connected"
 *  instead of resetting back to the unconnected prompt. Same
 *  toolCallId-then-scan-forward shape as findChooseAnswer above. */
function findConnectResolution(
  allMessages: readonly EveMessage[] | undefined,
  toolCallId: string,
  serviceName: string
): 'connected' | 'skipped' | undefined {
  if (!allMessages) return undefined;
  const toolMsgIdx = allMessages.findIndex(m => m.parts.some(p => p.type === 'dynamic-tool' && p.toolCallId === toolCallId));
  if (toolMsgIdx === -1) return undefined;
  for (let i = toolMsgIdx + 1; i < allMessages.length; i++) {
    const m = allMessages[i];
    if (m.role !== 'user') continue;
    const text = m.parts.filter((p): p is Extract<EveMessagePart, { type: 'text' }> => p.type === 'text').map(p => p.text).join('').trim();
    if (text === `Connected ${serviceName}.`) return 'connected';
    if (text.toLowerCase() === 'skip') return 'skipped';
  }
  return undefined;
}

function ToolPart({
  part,
  isStreaming,
  allMessages,
  onSend,
}: {
  part: EveDynamicToolPart;
  isStreaming?: boolean;
  allMessages?: readonly EveMessage[];
  onSend?: (text: string) => void;
}) {
  const toolName = part.toolMetadata?.eve?.name ?? part.toolName;

  // 2026-07-18: ANY tool's output (not just inject_credential's) can
  // signal "the user needs to connect something" via `needsConnect` —
  // render the shared inline connect card instead of falling through to
  // a generic/textual tool card, regardless of which tool produced it.
  if (part.state === 'output-available' && part.output && typeof part.output === 'object' && (part.output as any).needsConnect) {
    const output = part.output as { service?: string; connectMode?: 'oauth' | 'token'; reason?: 'repo_not_installed' };
    if (output.service) {
      const name = getKnownService(output.service)?.name ?? (output.service.charAt(0).toUpperCase() + output.service.slice(1));
      const initialResolved = findConnectResolution(allMessages, part.toolCallId, name);
      return (
        <IntegrationConnectCard
          key={part.toolCallId}
          service={output.service}
          connectMode={output.connectMode ?? 'token'}
          toolCallId={part.toolCallId}
          onSend={onSend}
          initialResolved={initialResolved}
          reason={output.reason}
        />
      );
    }
  }

  switch (toolName) {
    case 'code_artifact':
      return <CodeArtifactResult part={part} />;
    case 'web_search':
    case 'parallel_search':
      return <WebSearchResult part={part} />;
    case 'web_crawl':
      return <WebCrawlResult part={part} />;
    case 'browser_use':
      return <BrowserUseResult part={part} isStreaming={isStreaming} />;
    case 'task_analysis':
      return <TaskAnalysisCard part={part} />;
    case 'python_coding':
      return <PythonCodeResult part={part} />;
    case 'todo':
      return <TodoListResult part={part} />;
    case 'agent':
      return <AgentDelegateResult part={part} />;
    case 'choose': {
      const input = (part.state === 'output-available' ? part.output : part.input) as { options?: string[] } | undefined;
      const options = input?.options ?? [];
      const answered = findChooseAnswer(allMessages, part.toolCallId, options);
      return <ChooseResult part={part} answered={answered.length ? answered : undefined} onAnswer={onSend} />;
    }
    default:
      return <GenericToolCard part={part} />;
  }
}

/**
 * FIXED (2026-07-18, real perf bug found while chasing "streaming feels
 * janky" reports again after the transport-level pass didn't fully
 * resolve it -- different layer entirely). `memo()`'s default shallow
 * prop comparison was doing NOTHING here: `allMessages` is `useChat`'s
 * live `messages` array, which gets a brand-new array reference on every
 * single streamed token (confirmed in @ai-sdk/react's `AbstractChat` --
 * `pushMessage`/`replaceMessage` both do `this.state.messages = [...]`).
 * That meant every token forced React to re-render EVERY message
 * component in the whole thread, not just the one actually streaming --
 * in a long chat (50-200+ messages/parts is normal for a coding agent)
 * this gets progressively more expensive as the conversation grows,
 * independent of anything on the network/server side.
 *
 * Fix: custom comparator that ignores `allMessages`'/`onSend`'s
 * reference churn and only compares what actually matters for THIS
 * message: its own `message` object (stable across renders where it
 * hasn't changed -- only the actively-mutated message gets a new
 * reference per the same `replaceMessage` call above) and `isStreaming`.
 * `choose` and `needsConnect` cards are the only parts that read
 * `allMessages` themselves (scanning for a later resolving message) --
 * they can only ever change when a NEW message is appended after them,
 * so comparing `allMessages.length` (cheap) is sufficient for exactly
 * those, without reintroducing a full-array identity check that would
 * defeat the whole point of this fix.
 */
function messagePropsAreEqual(prev: MessageRendererProps, next: MessageRendererProps): boolean {
  if (prev.message !== next.message) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  const prevLen = prev.allMessages?.length ?? 0;
  const nextLen = next.allMessages?.length ?? 0;
  return prevLen === nextLen;
}

export const MessageRenderer = memo(function MessageRenderer({
  message,
  isStreaming = false,
  allMessages,
  onSend,
}: MessageRendererProps) {
  if (message.role === 'assistant') {
    return (
      <div className="flex flex-col items-start gap-2 w-full">
        {message.parts.map((part, idx) => {
          const isLastPart = isStreaming && idx === message.parts.length - 1;
          if (part.type === 'text') {
            return part.text ? (
              <MarkdownText key={idx} text={part.text} loading={isLastPart && part.state === 'streaming'} />
            ) : null;
          }
          if (part.type === 'reasoning') {
            return part.text ? (
              <AIReasoningCard key={idx} text={part.text} loading={isLastPart && part.state === 'streaming'} />
            ) : null;
          }
          if (part.type === 'dynamic-tool') {
            return (
              <ToolPart
                key={part.toolCallId}
                part={part}
                isStreaming={isLastPart}
                allMessages={allMessages}
                onSend={onSend}
              />
            );
          }
          if (part.type === 'authorization') {
            return <AuthorizationCard key={idx} part={part} />;
          }
          return null;
        })}
      </div>
    );
  }

  // user message
  const text = message.parts
    .filter((p): p is Extract<EveMessagePart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('');

  return (
    <div
      className={cn(
        'flex flex-col self-end p-3 inline-block max-w-full rounded-lg mb-4 bg-[#f3f3f3] text-foreground'
      )}
    >
      {text}
    </div>
  );
}, messagePropsAreEqual);
