'use client';

/**
 * Ported 1:1 from packages/frontend/app/src/components/chat-config.tsx.
 *
 * Key difference from the original: the model list is now fetched
 * dynamically from the Vercel AI Gateway catalog
 * (GET /api/server/models → gateway.getAvailableModels()) instead of
 * the hardcoded `tempModels` array. Provider icons are still used 1:1
 * (ClaudeIcon, ChatGPTIcon, GeminiIcon — ported verbatim from the
 * original's icons/ directory).
 *
 * Model switching works via eve subagent delegation, same as before —
 * the selected model id is sent in `clientContext` and the root agent's
 * instructions.md routes to the matching subagent. See the comment in
 * the previous version of this file for the full rationale.
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { getProviderIcon } from '@/components/icons/provider-icons';

interface GatewayModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
  description: string | null;
}

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

/** Default model id used when the Gateway is unreachable or hasn't loaded yet. */
const DEFAULT_MODEL_ID = 'claude-sonnet-4@20250514';

/** Fallback models matching the original's tempModels array. */
const FALLBACK_MODELS: ModelOption[] = [
  { label: 'Claude Sonnet 4', value: 'claude-sonnet-4@20250514', provider: 'anthropic', Icon: getProviderIcon('anthropic') },
  { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro', provider: 'google', Icon: getProviderIcon('google') },
  { label: 'GPT-5', value: 'gpt-5', provider: 'openai', Icon: getProviderIcon('openai') },
  { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash', provider: 'google', Icon: getProviderIcon('google') },
  { label: 'o4 Mini', value: 'o4-mini', provider: 'openai', Icon: getProviderIcon('openai') },
];

export function useGatewayModels(): {
  models: ModelOption[];
  loading: boolean;
  error: string | null;
} {
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/server/models');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const gatewayModels: GatewayModel[] = data.models || [];
        if (gatewayModels.length === 0) {
          if (!cancelled) setModels(FALLBACK_MODELS);
          return;
        }
        const options: ModelOption[] = gatewayModels.map(m => ({
          label: m.name,
          value: m.id,
          provider: m.provider,
          Icon: getProviderIcon(m.provider),
        }));
        if (!cancelled) {
          setModels(options);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setModels(FALLBACK_MODELS);
          setError(e instanceof Error ? e.message : 'Failed to load models');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { models, loading, error };
}

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
  const { models, loading } = useGatewayModels();

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
                  const current = models.find(m => m.value === model);
                  if (current) {
                    const Icon = current.Icon;
                    return <><Icon className="w-4 h-4 shrink-0" /><span className="flex-1 truncate">{current.label}</span></>;
                  }
                  return <span className="flex-1 truncate">{loading ? 'Loading…' : 'Select model'}</span>;
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
                {loading && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading models…</div>
                )}
                {models.map(m => {
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

/** Builds the plain-language model/tool-restriction hint for eve's `clientContext`. */
export function buildConfigContext(model: string, disabledTools: string[]): string | undefined {
  const parts: string[] = [];
  if (model && model !== DEFAULT_MODEL_ID) {
    parts.push(`Preferred model for this turn: ${model}. Delegate to the matching subagent per your model_routing instructions.`);
  }
  const toolLabels = configurableTools.filter(t => disabledTools.includes(t.value)).map(t => t.label);
  if (toolLabels.length) parts.push(`For this turn, avoid using: ${toolLabels.join(', ')}.`);
  return parts.length ? parts.join('\n') : undefined;
}
