'use client';

/**
 * Ported from pages/chats/renderers/choose-result.tsx — presents the
 * `choose` tool's options for the user to pick from. Original used a
 * `chatInputEmitter` singleton + `useChatMessages()` context to detect
 * whether the question was already answered (by scanning prior user
 * messages for a match) and to submit the answer as a new chat message.
 * Adaptation: takes an `onAnswer` callback wired by the chat interface
 * (which already owns `sendMessage`) instead of a global emitter — same
 * effective contract, no hidden singleton state.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

interface ChooseInput {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export function ChooseResult({
  part,
  onAnswer,
  answered,
}: {
  part: EveDynamicToolPart;
  onAnswer?: (answer: string) => void;
  /** Set once the user has answered (e.g. a later user message exists) so the picker locks. */
  answered?: string[];
}) {
  const input = (part.state === 'output-available' ? (part.output as ChooseInput | undefined) : (part.input as ChooseInput | undefined)) ?? undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const [selected, setSelected] = useState<string[]>(answered ?? []);
  const locked = (answered?.length ?? 0) > 0;

  const toggle = useCallback(
    (option: string) => {
      if (locked) return;
      setSelected(prev => {
        if (prev.includes(option)) return prev.filter(o => o !== option);
        if (input?.multiSelect) return [...prev, option];
        return [option];
      });
    },
    [locked, input?.multiSelect]
  );

  const submit = useCallback(() => {
    if (!selected.length) return;
    onAnswer?.(selected.join(', '));
  }, [selected, onAnswer]);

  if (isRunning || !input) {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-3 text-sm text-muted-foreground flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        Preparing options…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card w-full p-4">
      <div className="text-sm font-medium text-foreground mb-3">{input.question}</div>
      <ul className="flex flex-col gap-1">
        {input.options.map(option => {
          const isAnswered = answered?.includes(option);
          const isPending = selected.includes(option);
          return (
            <li
              key={option}
              onClick={() => toggle(option)}
              className={cn('flex items-center gap-2 px-2 py-1.5 rounded-md text-sm', !locked && 'cursor-pointer hover:bg-accent')}
            >
              <div className="w-4 h-4 flex items-center justify-center shrink-0">
                {locked ? (
                  isAnswered ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-primary"><path d="M20 6L9 17l-5-5" /></svg>
                  ) : (
                    <span className="w-3 h-3 rounded-full border border-muted-foreground" />
                  )
                ) : (
                  <span className={cn('w-3.5 h-3.5 rounded-full border', isPending ? 'border-primary bg-primary' : 'border-muted-foreground')} />
                )}
              </div>
              <span
                className={cn(
                  'text-foreground',
                  locked && !isAnswered && 'text-muted-foreground line-through',
                  locked && isAnswered && 'text-foreground font-medium'
                )}
              >
                {option}
              </span>
            </li>
          );
        })}
      </ul>
      {!locked && (
        <div className="flex justify-end mt-3">
          <button
            onClick={submit}
            disabled={!selected.length}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none h-8 px-3"
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
