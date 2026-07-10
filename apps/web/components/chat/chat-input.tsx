'use client';

import { ArrowUpBigIcon, SettingsIcon, AttachmentIcon } from '@blocksuite/icons/rc';
import { motion } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChatConfigMenu, DEFAULT_MODEL_ID } from './chat-config';
import { ContextSelectorMenu, ContextPreview, type AttachedContext } from './chat-context';

/** Default model id (first fallback entry — Claude Sonnet 4). */

export function ChatInput({
  onSend,
  placeholder = 'What are your thoughts?',
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
  /** Pre-attached context (e.g. opening a chat scoped to a specific doc). */
  initialAttached?: AttachedContext[];
  /**
   * Model selection is controlled from ChatInterface (not owned locally
   * here) so it can decide, BEFORE the first message of a new chat is
   * even sent, whether this is a BYOK-direct turn (bypasses eve/Gateway
   * entirely) or a normal eve turn. Falls back to local state so this
   * component still works standalone (e.g. in isolated usages/tests).
   */
  model?: string;
  onModelChange?: (model: string) => void;
}) {
  const [input, setInput] = useState('');
  const [attached, setAttached] = useState<AttachedContext[]>(initialAttached ?? []);
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [localModel, setLocalModel] = useState<string>(DEFAULT_MODEL_ID);
  const model = controlledModel ?? localModel;
  const setModel = onModelChange ?? setLocalModel;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [textareaHeight, setTextareaHeight] = useState(45);

  const updateTextAreaHeight = useCallback(() => {
    const maxHeight = 120;
    const target = textareaRef.current;
    if (!target) return;
    target.style.height = 'auto';
    const height = Math.min(target.scrollHeight, maxHeight);
    target.style.height = `${height}px`;
    setTextareaHeight(height);
  }, []);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateTextAreaHeight();
      setInput(e.currentTarget.value);
    },
    [updateTextAreaHeight]
  );

  const handleSend = useCallback(
    (message?: string) => {
      const messageToSend = message ?? input;
      if (!messageToSend.trim()) return;
      onSend(messageToSend, { attached, disabledTools, model });
      setInput('');
      setAttached([]);
      setTimeout(updateTextAreaHeight, 0);
    },
    [input, onSend, updateTextAreaHeight, attached, disabledTools, model]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isEmpty = e.currentTarget.value.trim() === '';
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (!isEmpty) {
          e.currentTarget.blur();
          handleSend();
        }
      }
    },
    [handleSend]
  );

  return (
    <div
      onClick={() => textareaRef.current?.focus()}
      className="transition duration-500 border border-input rounded-2xl p-4 w-full bg-card"
    >
      <ContextPreview attached={attached} onRemove={ctx => setAttached(prev => prev.filter(a => !(a.type === ctx.type && a.id === ctx.id)))} />
      <div className="w-full relative">
        <motion.div animate={{ height: textareaHeight }} layout transition={{ duration: 0.13, ease: 'easeOut' }}>
          <textarea
            name="chat-input"
            ref={textareaRef}
            rows={2}
            className="w-full resize-none bg-transparent focus:outline-none transition-[height] duration-150 text-sm text-foreground"
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </motion.div>
        {input.length === 0 && (
          <div className="absolute left-[2px] top-[2px] text-sm text-muted-foreground pointer-events-none flex items-center">
            {placeholder}
          </div>
        )}
      </div>
      <footer className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <ContextSelectorMenu attached={attached} onAttach={ctx => setAttached(prev => [...prev, ctx])}>
            <button
              type="button"
              title="Attach context"
              className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <AttachmentIcon className="w-4 h-4" />
            </button>
          </ContextSelectorMenu>
          <ChatConfigMenu model={model} setModel={setModel} disabledTools={disabledTools} setDisabledTools={setDisabledTools}>
            <button
              type="button"
              title="Tools"
              className={cn(
                'w-7 h-7 rounded-md flex items-center justify-center transition-colors',
                disabledTools.length > 0 || model !== DEFAULT_MODEL_ID ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
          </ChatConfigMenu>
        </div>
        {streaming ? (
          <button
            onClick={onAbort}
            className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center"
            title="Stop"
          >
            <div className="w-2 h-2 bg-background" />
          </button>
        ) : (
          <button
            disabled={!input.trim() || sending}
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              handleSend();
            }}
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center transition-opacity',
              input.trim() && !sending ? 'bg-primary opacity-100' : 'bg-muted opacity-50'
            )}
          >
            <ArrowUpBigIcon className="w-4 h-4 text-primary-foreground" />
          </button>
        )}
      </footer>
    </div>
  );
}
