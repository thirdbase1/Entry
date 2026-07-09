'use client';

import type { EveDynamicToolPart, EveMessage, EveMessagePart } from 'eve/react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolCard } from './renderers/generic-tool-card';
import { CodeArtifactResult } from './renderers/code-artifact-result';
import { DocComposeResult } from './renderers/doc-compose-result';
import { WebSearchResult } from './renderers/web-search-result';
import { WebCrawlResult } from './renderers/web-crawl-result';
import { BrowserUseResult } from './renderers/browser-use-result';
import { TaskAnalysisCard } from './renderers/task-analysis-card';
import { AuthorizationCard } from './renderers/authorization-card';
import { AIReasoningCard } from './renderers/ai-reasoning-card';
import { ChooseResult } from './renderers/choose-result';
import { TodoListResult } from './renderers/todo-list-result';
import { PythonCodeResult } from './renderers/python-code-result';
import { MakeItRealResult } from './renderers/make-it-real-result';

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

  switch (toolName) {
    case 'code_artifact':
      return <CodeArtifactResult part={part} />;
    case 'doc_compose':
      return <DocComposeResult part={part} />;
    case 'make_it_real':
      return <MakeItRealResult part={part} />;
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
        'flex flex-col self-end p-3 inline-block max-w-full rounded-lg mb-4 bg-muted text-foreground'
      )}
    >
      {text}
    </div>
  );
});
