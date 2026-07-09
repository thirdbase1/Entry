'use client';

/**
 * Simplified model selector — was a much bigger surface (dynamic fetch of
 * the ENTIRE Vercel AI Gateway catalog, dozens of models rendered in the
 * dropdown) but only 3 of those ever actually worked, because model
 * switching happens via delegation to exactly 3 declared eve subagents
 * (claude/gpt/gemini) — every other catalog entry a user could pick did
 * nothing. Rather than keep dressing up a catalog browser that mostly lied
 * about what was functional, this now just lists the 3 real, working
 * options. Honest and simpler; matches what apps/agent/agent/subagents
 * actually supports.
 *
 * The underlying model id per provider is still resolved live from the AI
 * Gateway catalog server-side (see apps/agent/agent/lib/model-catalog.ts) —
 * nothing here hardcodes a dated model id. These 3 values are stable
 * subagent NAMES, not model ids.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { getProviderIcon } from '@/components/icons/provider-icons';

export interface ModelOption {
  label: string;
  value: string;
  provider: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
}

export const configurableTools = [
  { label: 'Code Artifact', value: 'code_artifact' },
  { label: 'Make It Real', value: 'make_it_real' },
  { label: 'Doc Compose', value: 'doc_compose' },
  { label: 'Web Search', value: 'web_search' },
  { label: 'Python', value: 'python_coding' },
  { label: 'Browser Use', value: 'browser_use' },
  { label: 'Task Analysis', value: 'task_analysis' },
] as const;

export const defaultDisabledTools: string[] = [];

/** Root agent handles the turn itself when this (or '') is selected — no delegation. */
export const DEFAULT_MODEL_ID = 'default';

/** The 3 real, working options — must match apps/agent/agent/subagents/<id> exactly. */
export const MODEL_OPTIONS: ModelOption[] = [
  { label: 'Claude', value: 'claude', provider: 'anthropic', Icon: getProviderIcon('anthropic') },
  { label: 'GPT', value: 'gpt', provider: 'openai', Icon: getProviderIcon('openai') },
  { label: 'Gemini', value: 'gemini', provider: 'google', Icon: getProviderIcon('google') },
];

export function ChatConfigMenu({
  model,
  setModel,
  disabledTools,
  setDisabledTools,
  children,
}: {
  model: string;
  setModel: (model: string) => void;
  disabledTools: string[];
  setDisabledTools: (tools: string[]) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [showModelSub, setShowModelSub] = useState(false);

  const toggle = (value: string) => {
    setDisabledTools(
      disabledTools.includes(value)
        ? disabledTools.filter(t => t !== value)
        : [...disabledTools, value]
    );
  };

  return (
    <div className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setShowModelSub(false); }} />
          <div className="absolute bottom-full right-0 mb-2 w-64 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden z-20">
            {/* Model selector — sub-menu that expands inline */}
            <div className="px-3 py-2 text-xs text-muted-foreground border-b">Foundation Model</div>
            {!showModelSub ? (
              <button
                onClick={() => setShowModelSub(true)}
                className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-accent text-left border-b"
              >
                {(() => {
                  const current = MODEL_OPTIONS.find(m => m.value === model);
                  if (current) {
                    const Icon = current.Icon;
                    return <><Icon className="w-4 h-4 shrink-0" /><span className="flex-1 truncate">{current.label}</span></>;
                  }
                  return <span className="flex-1 truncate">Default</span>;
                })()}
                <span className="text-xs text-muted-foreground">›</span>
              </button>
            ) : (
              <div className="flex flex-col gap-0.5 p-2 border-b max-h-56 overflow-y-auto">
                <button
                  onClick={() => setShowModelSub(false)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent w-full text-left"
                >
                  <span>‹</span> Back
                </button>
                <button
                  onClick={() => { setModel(DEFAULT_MODEL_ID); setShowModelSub(false); }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent w-full',
                    model === DEFAULT_MODEL_ID || !model ? 'text-primary font-medium' : 'text-foreground'
                  )}
                >
                  <span className="flex-1 truncate">Default</span>
                  {(model === DEFAULT_MODEL_ID || !model) && <span className="text-xs">✓</span>}
                </button>
                {MODEL_OPTIONS.map(m => {
                  const Icon = m.Icon;
                  return (
                    <button
                      key={m.value}
                      onClick={() => { setModel(m.value); setShowModelSub(false); }}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent w-full',
                        model === m.value ? 'text-primary font-medium' : 'text-foreground'
                      )}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{m.label}</span>
                      {model === m.value && <span className="text-xs">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Tools section */}
            <div className="px-3 py-2 text-xs text-muted-foreground border-b">Tools for this turn</div>
            <div className="flex flex-col gap-0.5 p-2">
              {configurableTools.map(tool => {
                const enabled = !disabledTools.includes(tool.value);
                return (
                  <button
                    key={tool.value}
                    onClick={() => toggle(tool.value)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent w-full text-left"
                  >
                    <span className="flex-1 truncate">{tool.label}</span>
                    <span
                      className={cn(
                        'w-8 h-4.5 rounded-full relative transition-colors shrink-0',
                        enabled ? 'bg-primary' : 'bg-muted'
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-background transition-transform',
                          enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                        )}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Builds the structured routing signal for eve's `clientContext`, matching
 * apps/agent/agent/instructions.ts's <model_routing> hard rule. A clean,
 * minimal JSON object instead of the old prose sentence buried in other
 * text — nothing for the model to misparse.
 */
export function buildConfigContext(model: string, disabledTools: string[]): string | undefined {
  const parts: string[] = [];
  if (model && model !== DEFAULT_MODEL_ID) {
    parts.push(JSON.stringify({ requestedModel: model }));
  }
  const toolLabels = configurableTools.filter(t => disabledTools.includes(t.value)).map(t => t.label);
  if (toolLabels.length) parts.push(`Avoid using these tools for this turn: ${toolLabels.join(', ')}.`);
  return parts.length ? parts.join('\n') : undefined;
}
