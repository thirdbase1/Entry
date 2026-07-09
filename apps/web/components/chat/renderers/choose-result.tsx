'use client';

/**
 * Ported 1:1 from pages/chats/renderers/choose-result.tsx +
 * choose-result.css.ts. Restored: the signature success-green gradient
 * border (16px radius, diagonal gradient from status-success to a subtle
 * border color, masked to a 1.5px ring via padding+background-clip — same
 * ::after mask-composite:exclude trick as the original, reproduced with
 * plain CSS since this app doesn't use vanilla-extract), the exact
 * unanswered-state radio-dot selection UI (empty ring -> filled success
 * dot on select) vs answered-state check/circle icons (green check for
 * the chosen option(s), muted circle + strikethrough for the rest), and
 * the green Confirm button.
 *
 * Original used a `chatInputEmitter` singleton + `useChatMessages()`
 * context to detect a prior answer and to submit a new one. Adapted: takes
 * an `onAnswer` callback (wired by the chat interface, which already owns
 * `sendMessage`) and an `answered` prop (computed by message-renderer.tsx
 * by scanning later user messages) — same effective contract, no hidden
 * singleton state.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { SingleSelectCheckSolidIcon, SingleSelectUnIcon } from '@blocksuite/icons/rc';
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
      <div className="rounded-2xl border border-border bg-card w-full p-3 text-sm text-muted-foreground flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        Preparing options…
      </div>
    );
  }

  return (
    <div
      className="relative rounded-2xl not-prose"
      style={{
        background:
          'linear-gradient(155deg, var(--color-status-success) 0%, var(--color-border) 70%)',
        padding: '1.5px',
        boxShadow: '0px 1px 5px 0px rgba(0, 0, 0, 0.05)',
      }}
    >
      <div className="rounded-[calc(1rem-1.5px)] bg-card px-4 py-3">
        <div className="text-sm font-medium text-foreground leading-5.5 mb-2">{input.question}</div>
        <ul className="flex flex-col gap-0.5">
          {input.options.map(option => {
            const isAnswered = answered?.includes(option);
            const isPending = selected.includes(option);
            return (
              <li
                key={option}
                onClick={() => toggle(option)}
                className={cn('flex items-center gap-2 py-0.5', !locked && 'cursor-pointer')}
              >
                <div className="size-5 flex items-center justify-center shrink-0">
                  {locked ? (
                    isAnswered ? (
                      <SingleSelectCheckSolidIcon className="text-xl text-status-success" />
                    ) : (
                      <SingleSelectUnIcon className="text-xl text-icon-secondary" />
                    )
                  ) : input.multiSelect ? (
                    <span
                      className={cn(
                        'size-4 rounded border flex items-center justify-center',
                        isPending ? 'bg-status-success border-status-success' : 'border-icon-primary'
                      )}
                    >
                      {isPending && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                  ) : (
                    <div
                      className={cn(
                        'size-4 rounded-full text-icon-primary border flex items-center justify-center',
                        isPending && 'border-status-success'
                      )}
                    >
                      {isPending ? (
                        <motion.div
                          className="bg-status-success size-2 rounded-full"
                          initial={{ opacity: 0, scale: 0 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.2 }}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
                <div
                  className={cn(
                    'text-sm leading-5.5',
                    !locked && 'text-icon-primary',
                    !locked && isPending && 'text-status-success font-medium',
                    locked && !isAnswered && 'text-text-placeholder line-through',
                    locked && isAnswered && 'text-status-success font-medium'
                  )}
                >
                  {option}
                </div>
              </li>
            );
          })}
        </ul>
        {!locked && (
          <footer className="flex justify-end mt-1">
            <button
              onClick={submit}
              disabled={!selected.length}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium text-primary-foreground disabled:opacity-50 disabled:pointer-events-none h-8 px-3 transition-colors"
              style={{ backgroundColor: 'var(--color-status-success)' }}
            >
              Confirm
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
