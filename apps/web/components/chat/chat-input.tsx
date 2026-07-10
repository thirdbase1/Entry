'use client';

/**
 * Prompt input — ported 1:1 (structure, classNames, spring/blur transitions,
 * icon geometry) from thirdbase1/prompt-component-design-3's
 * components/prompt-input.tsx, per explicit instruction to copy that
 * design exactly rather than reinvent it. The only real changes:
 *
 * 1. `motion/react` -> `framer-motion` imports (same library — Motion
 *    renamed itself and framer-motion is now just its compat re-export —
 *    this repo already depends on framer-motion elsewhere, so importing
 *    under that name avoids the repo depending on both names for one lib).
 * 2. The reference's footer buttons were static decoration (a fake
 *    "Fable 5" label, a fake "Medium" effort toggle, a no-op plus icon).
 *    Those three slots are now real: model picker (ChatConfigMenu, same
 *    one used before — full BYOK + Gateway catalog), tools toggle
 *    (same menu, reused as a second trigger for its Tools section), and
 *    attach-context (ContextSelectorMenu). The persistent send/mic button
 *    is wired to the real onSend/onAbort instead of doing nothing.
 * 3. Reference had no concept of "streaming" (a turn already in flight) —
 *    added a third icon state (stop square) alongside arrow/mic, shown
 *    whenever `streaming` is true, wired to `onAbort`.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChatConfigMenu, DEFAULT_MODEL_ID, useModelOptions } from './chat-config';
import { ContextSelectorMenu, ContextPreview, type AttachedContext } from './chat-context';

const TRANSITION = { type: 'spring' as const, stiffness: 380, damping: 34 };

function ArrowUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return <div className="w-2 h-2 bg-background rounded-[1px]" />;
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="8" width="2.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="5.75" y="5" width="2.5" height="7.5" rx="1" fill="currentColor" opacity="0.7" />
      <rect x="10" y="2" width="2.5" height="10.5" rx="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

export function ChatInput({
  onSend,
  placeholder = 'Ask anything',
  sending,
  streaming,
  onAbort,
  initialAttached,
  model: controlledModel,
  onModelChange,
}: {
  onSend: (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string }) => void;
  onAbort?: () => void;
  placeholder?: string;
  sending?: boolean;
  streaming?: boolean;
  initialAttached?: AttachedContext[];
  model?: string;
  onModelChange?: (model: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [attached, setAttached] = useState<AttachedContext[]>(initialAttached ?? []);
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [localModel, setLocalModel] = useState<string>(DEFAULT_MODEL_ID);
  const model = controlledModel ?? localModel;
  const setModel = onModelChange ?? setLocalModel;
  const modelOptions = useModelOptions();
  const currentModel = modelOptions.find(m => m.value === model);

  const hasValue = input.trim() !== '';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const expand = useCallback(() => {
    setExpanded(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (!containerRef.current?.contains(e.relatedTarget as Node) && input.trim() === '' && attached.length === 0) {
        setExpanded(false);
      }
    },
    [input, attached]
  );

  const handleSend = useCallback(() => {
    if (input.trim() === '' || sending) return;
    onSend(input, { attached, disabledTools, model });
    setInput('');
    setAttached([]);
  }, [input, sending, onSend, attached, disabledTools, model]);

  return (
    <motion.div
      ref={containerRef}
      layout
      initial={false}
      transition={TRANSITION}
      onBlur={handleBlur}
      style={{ borderRadius: 24 }}
      className="relative w-full overflow-hidden bg-card border border-input"
    >
      <ContextPreview attached={attached} onRemove={ctx => setAttached(prev => prev.filter(a => !(a.type === ctx.type && a.id === ctx.id)))} />

      <AnimatePresence mode="popLayout" initial={false}>
        {expanded ? (
          <motion.textarea
            key="textarea"
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
              if (e.key === 'Escape' && input.trim() === '' && attached.length === 0) {
                setExpanded(false);
              }
            }}
            placeholder={placeholder}
            rows={3}
            aria-label="Prompt"
            className="block w-full resize-none bg-transparent px-5 pt-4 pr-14 text-sm leading-[17px] text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground"
          />
        ) : (
          <motion.button
            key="placeholder"
            type="button"
            onClick={expand}
            className="block w-full cursor-text px-5 py-[15.5px] pr-14 text-left text-sm font-medium leading-[17px] text-muted-foreground"
            aria-label="Open prompt input"
          >
            {placeholder}
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, filter: 'blur(4px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)', transition: { duration: 0.25, delay: 0.1, ease: 'easeOut' } }}
            exit={{ opacity: 0, filter: 'blur(6px)', transition: { duration: 0.22, ease: 'easeIn' } }}
            className="flex translate-y-px items-center gap-5 px-5 pt-2 pb-3"
            onClick={e => e.stopPropagation()}
          >
            <ChatConfigMenu model={model} setModel={setModel} disabledTools={disabledTools} setDisabledTools={setDisabledTools}>
              <button
                type="button"
                className="flex items-center gap-2 rounded-full py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Select model: ${currentModel?.label ?? 'Default'}`}
              >
                {currentModel ? <currentModel.Icon className="w-[15px] h-[15px]" /> : <BarsIcon />}
                <span className="text-sm font-medium text-foreground/50">{currentModel?.label ?? 'Default'}</span>
              </button>
            </ChatConfigMenu>

            <ChatConfigMenu model={model} setModel={setModel} disabledTools={disabledTools} setDisabledTools={setDisabledTools}>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1.5 rounded-full py-1 transition-colors',
                  disabledTools.length > 0 ? 'text-primary' : 'text-foreground/50 hover:text-foreground'
                )}
                aria-label="Tools for this turn"
              >
                <BarsIcon />
                <span className="text-sm font-medium">Tools{disabledTools.length > 0 ? ` (${disabledTools.length} off)` : ''}</span>
              </button>
            </ChatConfigMenu>

            <ContextSelectorMenu attached={attached} onAttach={ctx => setAttached(prev => [...prev, ctx])}>
              <button
                type="button"
                className="ml-auto mr-9 flex items-center justify-center rounded-full py-1 text-foreground/50 transition-colors hover:text-foreground"
                aria-label="Add attachment"
              >
                <PlusIcon />
              </button>
            </ContextSelectorMenu>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={streaming ? onAbort : expanded ? handleSend : expand}
        disabled={!streaming && expanded && hasValue && sending}
        aria-label={streaming ? 'Stop' : hasValue ? 'Send prompt' : 'Use voice input'}
        style={{ borderRadius: 9999 }}
        className={cn(
          'absolute right-2 bottom-2 flex size-8 items-center justify-center transition-opacity',
          streaming ? 'bg-foreground' : hasValue && !sending ? 'bg-accent text-accent-foreground hover:opacity-90' : 'bg-muted text-muted-foreground opacity-70'
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {streaming ? (
            <motion.span key="stop" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }} className="flex items-center justify-center">
              <StopIcon />
            </motion.span>
          ) : hasValue ? (
            <motion.span key="arrow" initial={{ opacity: 0, scale: 0.5, filter: 'blur(2px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, scale: 0.5, filter: 'blur(2px)' }} transition={{ duration: 0.15, ease: 'easeOut' }} className="flex items-center justify-center">
              <ArrowUpIcon />
            </motion.span>
          ) : (
            <motion.span key="mic" initial={{ opacity: 0, scale: 0.5, filter: 'blur(2px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, scale: 0.5, filter: 'blur(2px)' }} transition={{ duration: 0.15, ease: 'easeOut' }} className="flex items-center justify-center">
              <MicIcon />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </motion.div>
  );
}
