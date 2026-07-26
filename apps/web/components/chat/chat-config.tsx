'use client';

/**
 * Model selector — sourced entirely from real, individually-priced BYOK
 * connections (owner ask 2026-07-26: "remove those gateway fallback
 * totally... I mean the actual AI gateway, the model selector"). The
 * Vercel AI Gateway catalog tier (`/api/server/models`, a hardcoded
 * fallback list once live fetching was paused earlier the same day) is
 * gone from this picker entirely — every model shown here is either:
 *
 * 1. The user's own BYOK provider models (fetched from
 *    /api/user/byok/providers) — only ones toggled ON in Settings show up.
 * 2. Shared platform-paid relays (e.g. "HCNSec Relay") — same endpoint,
 *    now also returns `isShared: true` rows visible to every user, spend-
 *    capped server-side. Grouped separately in the UI so it's obvious
 *    which models are free-to-you vs. your own key.
 *
 * Selecting either sends `{byokModelId}` — never `{requestedModel}` /
 * `gateway:` anymore, that whole code path stays only for backward compat
 * with a model value a user might already have saved as their default.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingPanel } from './floating-panel';
import { cn } from '@/lib/utils';
import { getProviderIcon } from '@/components/icons/provider-icons';
import { inferModelFamily } from '@/lib/model-provider';
import { looksLikeReasoningModel } from '@/lib/reasoning-detection';

export interface ModelOption {
  label: string;
  value: string; // "byok:<providerModelRowId>"
  provider: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
  group: 'Shared' | 'Your providers';
}

export const configurableTools = [
  { label: 'Code Artifact', value: 'code_artifact' },
  { label: 'Web Search', value: 'web_search' },
  { label: 'Python', value: 'python_coding' },
  { label: 'Write File', value: 'write_file' },
  { label: 'Edit File', value: 'edit_file' },
  { label: 'Bash', value: 'bash' },
  { label: 'Browser Use', value: 'browser_use' },
  { label: 'Task Analysis', value: 'task_analysis' },
  // Sub-agent delegation (2026-07-15) -- now wired into direct-chat's own
  // `tools` object too (previously eve-root-only), see route.ts's
  // "ENABLED" comment. Toggleable like everything else here in case a
  // user wants to guarantee a turn never fans work out to another model.
  { label: 'Agent Delegation', value: 'agent' },
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
      const byokRes = await fetch('/api/user/byok/providers').then(r => r.json()).catch(() => null);

      const byokModels: ModelOption[] =
        byokRes && Array.isArray(byokRes.providers)
          ? byokRes.providers.flatMap((p: any) =>
              (p.models ?? [])
                .filter((m: any) => m.isEnabled)
                .map((m: any) => {
                  // Icon comes from the MODEL NAME (e.g. "llama-3.1-70b" -> Meta,
                  // "claude-3-5-sonnet" -> Anthropic), never from the connection's
                  // transport/compatibility mode — a Llama model served over an
                  // OpenAI-compatible endpoint should still show the Meta logo.
                  const family = inferModelFamily(m.label || m.modelId);
                  const group: ModelOption['group'] = p.isShared ? 'Shared' : 'Your providers';
                  // Shared relays (owner ask 2026-07-27: "make sure on the
                  // hcnsec only show the model name in the model selector
                  // don't show the hcnsec provider or stuff saying the
                  // model is routing") show ONLY the bare model name --
                  // no "<provider label> · " prefix, no routing/relay
                  // wording. The "Shared" group header already tells the
                  // user these are platform-provided; repeating the
                  // provider's internal relay name (e.g. "HCNSec Relay")
                  // next to every model added noise with zero value to a
                  // user just trying to pick a model. Your-own-provider
                  // rows keep the prefix since a user can have several
                  // providers serving models with the same bare name.
                  const label = p.isShared ? (m.label || m.modelId) : `${p.label} · ${m.label || m.modelId}`;
                  return {
                    label,
                    value: `byok:${m.id}`,
                    provider: family,
                    Icon: getProviderIcon(family),
                    group,
                  };
                })
            )
          : [];

      if (!cancelled) setOptions(byokModels);
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
  // 'gateway:' prefix kept parseable for backward compat only -- a user
  // who already had a Gateway model saved as their default before the
  // picker dropped that tier keeps working exactly as before, it just
  // can't be picked again from this menu.
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
  children,
}: {
  model: string;
  setModel: (model: string) => void;
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
    const shared = filtered.filter(o => o.group === 'Shared');
    return { byok, shared };
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

              {grouped.shared.length > 0 && (
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-0.5">Shared (free to you)</div>
              )}
              {grouped.shared.map(m => (
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
    const shared = filtered.filter(o => o.group === 'Shared');
    return { byok, shared };
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

                  {grouped.shared.length > 0 && (
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-0.5">Shared (free to you)</div>
                  )}
                  {grouped.shared.map(m => (
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
