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
import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingPanel } from './floating-panel';
import { cn } from '@/lib/utils';
import { getProviderIcon } from '@/components/icons/provider-icons';
import { inferModelFamily } from '@/lib/model-provider';
import { looksLikeReasoningModel } from '@/lib/reasoning-detection';

export interface ModelOption {
  label: string;
  value: string; // "gateway:<slug>" or "byok:<providerModelRowId>"
  provider: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
  group: 'Gateway' | 'Your providers';
  /** Whether this model supports the AI SDK's portable `reasoning` effort control. */
  supportsReasoning: boolean;
}

/** Levels accepted by AI SDK's top-level `reasoning` streamText/generateText
 *  parameter — see ai-sdk.dev/docs/ai-sdk-core/reasoning. Portable across
 *  every reasoning-capable provider (OpenAI, Anthropic, Google, xAI, Groq,
 *  DeepSeek, Fireworks, Bedrock); a provider that doesn't support it just
 *  ignores it with a warning, so it's always safe to send. */
// Full portable set per ai-sdk.dev/docs/ai-sdk-core/reasoning (AI SDK 7) —
// this previously only listed 4 of the 7 real levels (missing 'minimal'
// and 'xhigh'), silently coercing either pick down to 'provider-default'
// server-side. 'provider-default' itself is included too, as an explicit
// "Auto" choice (see AUTO_LABEL below) rather than only being reachable
// by omission.
export const REASONING_EFFORT_LEVELS = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];
// Confirmed real latency cause (2026-07-11, user-reported "slow after tool
// calling"): the chosen `reasoning` level applies to the WHOLE agentic
// loop (stepCountIs(120) in route.ts), not just the final user-facing
// reply -- every single intermediate step (deciding to call a tool,
// then again after each tool result) pays the full reasoning-token tax
// for a model that supports it. AI SDK's streamText has no portable
// per-step reasoning override (checked PrepareStepResult's real type in
// node_modules/ai/dist/index.d.ts -- only providerOptions, which would
// mean reintroducing the exact non-portable per-provider special-casing
// `reasoning` was added specifically to replace). 'medium' by default
// compounded across a typical multi-tool-call turn was the single
// biggest, most direct lever available without a much bigger redesign.
// 'low' is still meaningfully better than 'none' for tricky requests,
// while nowhere near as expensive per step -- a user who wants deep
// thinking for one specific hard question can still pick 'high' from
// the picker.
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  'provider-default': 'Auto',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
};
const REASONING_EFFORT_STORAGE_KEY = 'entry:lastReasoningEffort';

export function useReasoningEffort() {
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() => {
    if (typeof window === 'undefined') return DEFAULT_REASONING_EFFORT;
    try {
      const stored = window.localStorage.getItem(REASONING_EFFORT_STORAGE_KEY);
      return (REASONING_EFFORT_LEVELS as readonly string[]).includes(stored || '')
        ? (stored as ReasoningEffort)
        : DEFAULT_REASONING_EFFORT;
    } catch {
      return DEFAULT_REASONING_EFFORT;
    }
  });
  const setReasoningEffort = (level: ReasoningEffort) => {
    setReasoningEffortState(level);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, level);
    } catch {
      // best-effort persistence only
    }
  };
  return [reasoningEffort, setReasoningEffort] as const;
}

export const configurableTools = [
  { label: 'Code Artifact', value: 'code_artifact' },
  { label: 'Make It Real', value: 'make_it_real' },
  { label: 'Doc Compose', value: 'doc_compose' },
  { label: 'Web Search', value: 'web_search' },
  { label: 'Python', value: 'python_coding' },
  { label: 'Bash', value: 'bash' },
  { label: 'Browser Use', value: 'browser_use' },
  { label: 'Task Analysis', value: 'task_analysis' },
  // Credential vault + self-authored skills (2026-07-11) — user-toggleable
  // like every other tool above, in case someone wants to guarantee the
  // agent never touches saved credentials for a particular chat.
  { label: 'Save Credential', value: 'save_credential' },
  { label: 'List Credentials', value: 'list_credentials' },
  { label: 'Inject Credential', value: 'inject_credential' },
  { label: 'Create Skill', value: 'create_skill' },
  { label: 'List Skills', value: 'list_skills' },
  { label: 'Recall Skill', value: 'recall_skill' },
  { label: 'Preview URL', value: 'get_preview_url' },
  { label: 'Restart Sandbox', value: 'restart_sandbox' },
] as const;

export const defaultDisabledTools: string[] = [];

/** Root agent handles the turn itself when this (or '') is selected — no delegation. */
export const DEFAULT_MODEL_ID = 'default';

export function useModelOptions() {
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
              supportsReasoning: !!m.reasoning,
            }))
          : [];

      // Fingerprint source for BYOK reasoning detection below — every
      // Gateway model id already confirmed reasoning-capable via the
      // catalog's real tags (see /api/server/models). Zero extra request:
      // this is the same response already fetched for gatewayModels above.
      const gatewayReasoningIds: string[] =
        gatewayRes.status === 'fulfilled' && Array.isArray(gatewayRes.value?.models)
          ? gatewayRes.value.models.filter((m: any) => m.reasoning).map((m: any) => m.id as string)
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
                  // BYOK models don't come with Gateway catalog tags — the
                  // user can point a BYOK connection at literally any base
                  // URL, so there's no catalog to look their model up in.
                  // Best-effort instead: fingerprint-match the model's OWN
                  // id/label against every Gateway model id already confirmed
                  // reasoning-capable (fast, no extra request — reuses
                  // gatewayReasoningIds above), with a static well-known
                  // naming-pattern fallback (o1/o3/r1/thinking/etc.) for
                  // models the Gateway catalog doesn't carry at all. See
                  // lib/reasoning-detection.ts for the full matching logic.
                  const supportsReasoning = looksLikeReasoningModel(m.modelId || m.label || '', gatewayReasoningIds);
                  return {
                    label: `${p.label} · ${m.label || m.modelId}`,
                    value: `byok:${m.id}`,
                    provider: family,
                    Icon: getProviderIcon(family),
                    group: 'Your providers' as const,
                    supportsReasoning,
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

/**
 * Standalone model picker — the model button in chat-input.tsx (the one
 * that shows the current model's icon + name, e.g. "Fable 5") now opens
 * THIS instead of the full ChatConfigMenu. Same underlying model list/
 * search/selection logic as ChatConfigMenu's old nested "Foundation Model"
 * sub-panel, just promoted to be its own lightweight popover with nothing
 * else in it — no Tools section, no Back button, since it's not nested
 * inside anything anymore. The gear/tools icon keeps opening the full
 * ChatConfigMenu below, completely unchanged.
 */
export function ModelPickerMenu({
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  children,
}: {
  model: string;
  setModel: (model: string) => void;
  /** Omit both if this surface doesn't support reasoning effort selection. */
  reasoningEffort?: ReasoningEffort;
  setReasoningEffort?: (level: ReasoningEffort) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useModelOptions();
  const selectedOption = useMemo(() => options.find(o => o.value === model), [options, model]);

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

  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={anchorRef} className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      <FloatingPanel open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="left">
        <div className="w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1.5 border-b">
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search models…"
                className="flex-1 h-7 px-2 rounded-md border bg-background text-xs outline-none focus:border-primary"
              />
            </div>
            <div className="flex flex-col gap-0.5 p-2 max-h-72 overflow-y-auto">
              <button
                onClick={() => { setModel(DEFAULT_MODEL_ID); setOpen(false); }}
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
                  onClick={() => { setModel(m.value); setOpen(false); }}
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
                  onClick={() => { setModel(m.value); setOpen(false); }}
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
      </FloatingPanel>
    </div>
  );
}

/**
 * Standalone reasoning-effort toolbar control — split out of
 * ModelPickerMenu (2026-07-11) so it lives next to the Tools toggle in
 * chat-input.tsx's own toolbar instead of being buried inside the model
 * dropdown, where it was easy to miss and disconnected from the
 * "supports reasoning" gating a user actually cares about in the moment.
 * Self-hides (renders null) when the current model doesn't support
 * reasoning at all — same `supportsReasoning` flag ModelPickerMenu uses,
 * sourced from the real Gateway catalog's reasoning tags for Gateway
 * models, and the best-effort fingerprint heuristic (lib/reasoning-
 * detection.ts) for BYOK models, since there's no capability-discovery
 * API for an arbitrary BYOK base URL to check against.
 */
export function ReasoningEffortMenu({
  model,
  reasoningEffort,
  setReasoningEffort,
  children,
}: {
  model: string;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (level: ReasoningEffort) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const options = useModelOptions();
  const selectedOption = useMemo(() => options.find(o => o.value === model), [options, model]);
  const anchorRef = useRef<HTMLDivElement>(null);

  if (!selectedOption?.supportsReasoning) return null;

  return (
    <div ref={anchorRef} className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      <FloatingPanel open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="left">
        <div className="w-40 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden p-1">
          {REASONING_EFFORT_LEVELS.map(level => (
            <button
              key={level}
              onClick={() => {
                setReasoningEffort(level);
                setOpen(false);
              }}
              className={cn(
                'flex items-center justify-between w-full px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent',
                reasoningEffort === level ? 'text-primary font-medium' : 'text-foreground'
              )}
            >
              {REASONING_EFFORT_LABELS[level]}
            </button>
          ))}
        </div>
      </FloatingPanel>
    </div>
  );
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
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={anchorRef} className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      <FloatingPanel
        open={open}
        onClose={() => { setOpen(false); setShowModelSub(false); }}
        anchorRef={anchorRef}
        align="right"
      >
        <div className="w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden">
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
      </FloatingPanel>
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
