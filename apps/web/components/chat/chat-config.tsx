'use client';

/**
 * Model selector — now genuinely dynamic on two axes:
 *
 * 1. AI Gateway catalog (fetched from /api/server/models) — every model
 *    Vercel's Gateway exposes, routed at request time via apps/agent's
 *    `run_model` tool (see instructions.ts <model_routing>). No longer
 *    limited to 3 hardcoded subagents.
 * 2. The user's own BYOK provider models (fetched from
 *    /api/user/byok/providers) — only ones toggled ON in Settings show up
 *    here. Selecting one sends `{byokModelId}` instead of `{requestedModel}`.
 *
 * Both resolve through the same run_model tool server-side with full tool
 * parity — this menu is just a picker over "which model slug/BYOK id to
 * send".
 */
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { getProviderIcon } from '@/components/icons/provider-icons';
import { inferModelFamily } from '@/lib/model-provider';

export interface ModelOption {
  label: string;
  value: string; // "gateway:<slug>" or "byok:<providerModelRowId>"
  provider: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
  group: 'Gateway' | 'Your providers';
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

function useModelOptions() {
  const [options, setOptions] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [gatewayRes, byokRes] = await Promise.allSettled([
        fetch('/api/server/models').then(r => r.json()),
        fetch('/api/user/byok/providers').then(r => r.json()),
      ]);

      const gatewayModels: ModelOption[] =
        gatewayRes.status === 'fulfilled' && Array.isArray(gatewayRes.value?.models)
          ? gatewayRes.value.models.map((m: any) => ({
              label: m.name,
              value: `gateway:${m.id}`,
              provider: m.provider,
              Icon: getProviderIcon(m.provider),
              group: 'Gateway' as const,
            }))
          : [];

      const byokModels: ModelOption[] =
        byokRes.status === 'fulfilled' && Array.isArray(byokRes.value?.providers)
          ? byokRes.value.providers.flatMap((p: any) =>
              (p.models ?? [])
                .filter((m: any) => m.isEnabled)
                .map((m: any) => {
                  // Icon comes from the MODEL NAME (e.g. "llama-3.1-70b" -> Meta,
                  // "claude-3-5-sonnet" -> Anthropic), never from the connection's
                  // transport/compatibility mode — a Llama model served over an
                  // OpenAI-compatible endpoint should still show the Meta logo.
                  const family = inferModelFamily(m.label || m.modelId);
                  return {
                    label: `${p.label} · ${m.label || m.modelId}`,
                    value: `byok:${m.id}`,
                    provider: family,
                    Icon: getProviderIcon(family),
                    group: 'Your providers' as const,
                  };
                })
            )
          : [];

      if (!cancelled) setOptions([...byokModels, ...gatewayModels]);
    })();
    return () => { cancelled = true; };
  }, []);

  return options;
}

/**
 * Turns the menu's internal `value` (e.g. "gateway:anthropic/claude-opus-4.8"
 * or "byok:5b1e...") into the structured payload buildConfigContext sends.
 */
function parseModelValue(value: string): { requestedModel?: string; byokModelId?: string } {
  if (value.startsWith('gateway:')) return { requestedModel: value.slice('gateway:'.length) };
  if (value.startsWith('byok:')) return { byokModelId: value.slice('byok:'.length) };
  return {};
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
  const [query, setQuery] = useState('');
  const options = useModelOptions();

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter(o => o.label.toLowerCase().includes(q) || o.provider.toLowerCase().includes(q));
  }, [options, query]);

  const grouped = useMemo(() => {
    const byok = filtered.filter(o => o.group === 'Your providers');
    const gateway = filtered.filter(o => o.group === 'Gateway');
    return { byok, gateway };
  }, [filtered]);

  const toggle = (value: string) => {
    setDisabledTools(
      disabledTools.includes(value)
        ? disabledTools.filter(t => t !== value)
        : [...disabledTools, value]
    );
  };

  const current = options.find(m => m.value === model);

  return (
    <div className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setShowModelSub(false); }} />
          <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden z-20">
            {/* Model selector — sub-menu that expands inline */}
            <div className="px-3 py-2 text-xs text-muted-foreground border-b">Foundation Model</div>
            {!showModelSub ? (
              <button
                onClick={() => setShowModelSub(true)}
                className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-accent text-left border-b"
              >
                {current ? (
                  <><current.Icon className="w-4 h-4 shrink-0" /><span className="flex-1 truncate">{current.label}</span></>
                ) : (
                  <span className="flex-1 truncate">Default</span>
                )}
                <span className="text-xs text-muted-foreground">›</span>
              </button>
            ) : (
              <div className="flex flex-col border-b">
                <div className="flex items-center gap-2 px-2 pt-2">
                  <button
                    onClick={() => setShowModelSub(false)}
                    className="flex items-center gap-1 px-1.5 py-1 rounded-md text-sm text-muted-foreground hover:bg-accent"
                  >
                    <span>‹</span> Back
                  </button>
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search models…"
                    className="flex-1 h-7 px-2 rounded-md border bg-background text-xs outline-none focus:border-primary"
                  />
                </div>
                <div className="flex flex-col gap-0.5 p-2 max-h-64 overflow-y-auto">
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

                  {grouped.byok.length > 0 && (
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-0.5">Your providers</div>
                  )}
                  {grouped.byok.map(m => (
                    <button
                      key={m.value}
                      onClick={() => { setModel(m.value); setShowModelSub(false); }}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent w-full',
                        model === m.value ? 'text-primary font-medium' : 'text-foreground'
                      )}
                    >
                      <m.Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{m.label}</span>
                      {model === m.value && <span className="text-xs">✓</span>}
                    </button>
                  ))}

                  {grouped.gateway.length > 0 && (
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-0.5">Gateway</div>
                  )}
                  {grouped.gateway.map(m => (
                    <button
                      key={m.value}
                      onClick={() => { setModel(m.value); setShowModelSub(false); }}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent w-full',
                        model === m.value ? 'text-primary font-medium' : 'text-foreground'
                      )}
                    >
                      <m.Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{m.label}</span>
                      {model === m.value && <span className="text-xs">✓</span>}
                    </button>
                  ))}

                  {filtered.length === 0 && (
                    <div className="text-xs text-muted-foreground px-2 py-3 text-center">No models match "{query}"</div>
                  )}
                </div>
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
 * apps/agent/agent/instructions.ts's <model_routing> hard rule.
 */
export function buildConfigContext(model: string, disabledTools: string[]): string | undefined {
  const parts: string[] = [];
  if (model && model !== DEFAULT_MODEL_ID) {
    const parsed = parseModelValue(model);
    if (parsed.requestedModel || parsed.byokModelId) parts.push(JSON.stringify(parsed));
  }
  const toolLabels = configurableTools.filter(t => disabledTools.includes(t.value)).map(t => t.label);
  if (toolLabels.length) parts.push(`Avoid using these tools for this turn: ${toolLabels.join(', ')}.`);
  return parts.length ? parts.join('\n') : undefined;
}
