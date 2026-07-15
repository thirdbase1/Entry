'use client';

/**
 * BYOK (bring-your-own-key) provider settings. A user adds a "connection"
 * (base URL + compatibility mode + optional API key), fetches its
 * available models with one click (hits our own /fetch-models "fetch
 * agent" route, which calls the provider's own discovery endpoint), then
 * toggles individual models on/off — only enabled ones show up in the
 * chat model selector. A selected BYOK model routes straight to
 * /api/direct/chat at chat time (no eve/root-agent relay), with full
 * tool parity, nothing gated.
 */
import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, DeleteIcon } from '@blocksuite/icons/rc';
import { AutoSidebarPadding } from '@/components/layout/auto-sidebar-padding';
import { cn } from '@/lib/utils';
import { AutoSaveField, Toggle, safeJson } from '@/components/settings/shared';
import { IntegrationsSection } from '@/components/settings/integrations-section';

type Compatibility = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'OPENAI_RESPONSES';

interface ProviderModel {
  id: string;
  modelId: string;
  label?: string | null;
  isEnabled: boolean;
  /** Manual per-model override of the server's reasoning-capability
   *  heuristic (see reasoning-capability.ts) — when on, /api/direct/chat
   *  always forwards the user's picked reasoning effort to this model
   *  regardless of what the naming-pattern guess thinks, so a
   *  reasoning-capable model the heuristic doesn't recognize can still
   *  show "thinking". Off by default; purely additive. */
  reasoningEnabled: boolean;
  /** "Test connection" result (settings page, 2026-07-15) — null status
   *  means never tested. Persisted server-side so this survives a reload. */
  lastTestedAt?: string | null;
  lastTestStatus?: 'success' | 'error' | null;
  lastTestError?: string | null;
}

interface Provider {
  id: string;
  label: string;
  compatibility: Compatibility;
  baseUrl: string;
  hasApiKey: boolean;
  lastFetchedAt?: string | null;
  lastError?: string | null;
  models: ProviderModel[];
}

const COMPAT_OPTIONS: { value: Compatibility; label: string; hint: string }[] = [
  { value: 'OPENAI', label: 'OpenAI-compatible', hint: 'Groq, Together, Fireworks, OpenRouter, DeepInfra, Mistral, xAI, local vLLM/LM Studio/Ollama, most others' },
  { value: 'ANTHROPIC', label: 'Anthropic-compatible', hint: 'Endpoints that mirror the Anthropic Messages API' },
  { value: 'GOOGLE', label: 'Google-compatible', hint: 'Endpoints that mirror the Google Generative Language API' },
  {
    value: 'OPENAI_RESPONSES',
    label: 'OpenAI Responses API-compatible',
    hint: "Aggregators that proxy models behind OpenAI's newer Responses API shape (input/output, not messages/choices) — e.g. Kie.ai's per-model endpoints (Grok, GPT, Gemini, Claude). Base URL must include the model family segment + /v1, e.g. https://api.kie.ai/grok/v1",
  },
];

function AddProviderForm({ onCreated }: { onCreated: (p: Provider) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [compatibility, setCompatibility] = useState<Compatibility>('OPENAI');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!label.trim() || !baseUrl.trim()) {
      setError('Label and base URL are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/user/byok/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, compatibility, baseUrl, apiKey: apiKey || undefined }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to add provider');
      onCreated({ ...json, models: [] });
      setOpen(false);
      setLabel('');
      setBaseUrl('');
      setApiKey('');
      setCompatibility('OPENAI');
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }, [label, compatibility, baseUrl, apiKey, onCreated]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 h-9 rounded-md text-sm border hover:bg-accent transition-colors text-foreground"
      >
        <PlusIcon className="w-4 h-4" />
        Add BYOK provider
      </button>
    );
  }

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-card">
      <div className="text-sm font-medium text-foreground">New provider connection</div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground text-xs">Label</span>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. My Groq key"
          className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground text-xs">Compatible with</span>
        <select
          value={compatibility}
          onChange={e => setCompatibility(e.target.value as Compatibility)}
          className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary"
        >
          {COMPAT_OPTIONS.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {COMPAT_OPTIONS.find(c => c.value === compatibility)?.hint}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground text-xs">Base URL</span>
        <input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://api.groq.com/openai/v1"
          className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary font-mono"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground text-xs">API key (optional — leave blank for key-less endpoints)</span>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary font-mono"
        />
      </label>

      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={submit}
          disabled={saving}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save connection'}
        </button>
        <button onClick={() => setOpen(false)} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ManualModelAdd({ providerId, onAdded }: { providerId: string; onAdded: (m: ProviderModel) => void }) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    if (!modelId.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/user/byok/providers/${providerId}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: modelId.trim() }),
      });
      const json = await safeJson(res);
      if (res.ok) {
        onAdded(json);
        setModelId('');
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }, [modelId, providerId, onAdded]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
        + add a model id manually
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={modelId}
        onChange={e => setModelId(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="exact model id, e.g. llama-3.3-70b-versatile"
        autoFocus
        className="h-8 px-2 rounded-md border bg-background text-foreground text-xs font-mono flex-1 outline-none focus:border-primary"
      />
      <button onClick={submit} disabled={saving} className="h-8 px-2 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50">
        Add
      </button>
      <button onClick={() => setOpen(false)} className="h-8 px-2 text-xs text-muted-foreground hover:bg-accent rounded-md">
        Cancel
      </button>
    </div>
  );
}

function ProviderCard({ provider, onUpdate, onDelete }: { provider: Provider; onUpdate: (p: Provider) => void; onDelete: () => void }) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(provider.lastError ?? null);
  const [editingKey, setEditingKey] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');

  // Copy-the-key-I-already-added (2026-07-15, explicit request) — the key
  // is AES-256-GCM at rest (packages/db/src/crypto/byok.ts), always
  // reversible server-side; this just exposes that on an explicit click via
  // GET /reveal-key instead of never at all. Never stored in component
  // state longer than the copy itself takes -- fetched, written straight to
  // the clipboard, and discarded, so it never lingers in memory or gets
  // rendered as plaintext anywhere.
  const copyApiKey = useCallback(async () => {
    setCopyState('copying');
    try {
      const res = await fetch(`/api/user/byok/providers/${provider.id}/reveal-key`);
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error ?? 'Failed to reveal key');
      await navigator.clipboard.writeText(json.apiKey);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 1500);
    }
  }, [provider.id]);

  /** PATCHes the provider connection itself (label / base URL / API key) —
   * used by the AutoSaveField instances below. Throws on a non-OK response
   * so AutoSaveField reverts the input instead of showing a false "Saved". */
  const [compatSaving, setCompatSaving] = useState(false);

  const patchProvider = useCallback(
    async (patch: { label?: string; compatibility?: Compatibility; baseUrl?: string; apiKey?: string }) => {
      const res = await fetch(`/api/user/byok/providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to save');
      onUpdate({ ...provider, ...json });
    },
    [provider, onUpdate]
  );

  // Change compatibility anytime, no need to re-create the connection
  // (2026-07-15, explicit user request). Fires immediately on select --
  // this isn't a free-typed AutoSaveField, there's nothing to debounce.
  const changeCompatibility = useCallback(
    async (next: Compatibility) => {
      if (next === provider.compatibility) return;
      setCompatSaving(true);
      try {
        await patchProvider({ compatibility: next });
      } catch {
        // patchProvider already leaves `provider` untouched on failure
        // (onUpdate is only called after a successful response), so the
        // select just needs to re-render back to the real current value.
      } finally {
        setCompatSaving(false);
      }
    },
    [provider.compatibility, patchProvider]
  );

  const fetchModels = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/user/byok/providers/${provider.id}/fetch-models`, { method: 'POST' });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error ?? 'Fetch failed');
      onUpdate({ ...provider, models: json.models, lastError: null });
    } catch (e: any) {
      setFetchError(e.message ?? 'Failed to fetch models');
    } finally {
      setFetching(false);
    }
  }, [provider, onUpdate]);

  const toggleModel = useCallback(
    async (modelRowId: string, isEnabled: boolean) => {
      onUpdate({ ...provider, models: provider.models.map(m => (m.id === modelRowId ? { ...m, isEnabled } : m)) });
      await fetch(`/api/user/byok/providers/${provider.id}/models/${modelRowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled }),
      });
    },
    [provider, onUpdate]
  );

  // Manual reasoning override toggle (2026-07-11) — see ProviderModel's
  // `reasoningEnabled` comment for why this exists. Same optimistic-update
  // + fire-and-forget PATCH pattern as toggleModel above, just the other
  // field.
  const toggleReasoning = useCallback(
    async (modelRowId: string, reasoningEnabled: boolean) => {
      onUpdate({ ...provider, models: provider.models.map(m => (m.id === modelRowId ? { ...m, reasoningEnabled } : m)) });
      await fetch(`/api/user/byok/providers/${provider.id}/models/${modelRowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoningEnabled }),
      });
    },
    [provider, onUpdate]
  );

  const removeModel = useCallback(
    async (modelRowId: string) => {
      onUpdate({ ...provider, models: provider.models.filter(m => m.id !== modelRowId) });
      await fetch(`/api/user/byok/providers/${provider.id}/models/${modelRowId}`, { method: 'DELETE' });
    },
    [provider, onUpdate]
  );

  // "Test connection" (2026-07-15, explicit request): pick a model from a
  // dropdown (useful once a provider has several) and fire one real,
  // minimal completion at it so a user can confirm the connection actually
  // works before relying on it in chat — green on success, red + the
  // upstream error on failure. Result persists via the model row's own
  // lastTestStatus/lastTestError (see the PATCH-like update in the /test
  // route), so onUpdate here just mirrors what the server already saved.
  const [testModelId, setTestModelId] = useState<string>(provider.models[0]?.id ?? '');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!provider.models.some(m => m.id === testModelId)) {
      setTestModelId(provider.models[0]?.id ?? '');
    }
    // Only re-derive when the set of models actually changes, not on every
    // keystroke elsewhere on the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.models]);

  const testConnection = useCallback(async () => {
    if (!testModelId) return;
    setTesting(true);
    try {
      const res = await fetch(`/api/user/byok/providers/${provider.id}/models/${testModelId}/test`, { method: 'POST' });
      const json = await safeJson(res);
      const success = res.ok && json.success;
      onUpdate({
        ...provider,
        models: provider.models.map(m =>
          m.id === testModelId
            ? { ...m, lastTestedAt: new Date().toISOString(), lastTestStatus: success ? 'success' : 'error', lastTestError: success ? null : (json.error ?? 'Test failed') }
            : m
        ),
      });
    } catch (e: any) {
      onUpdate({
        ...provider,
        models: provider.models.map(m =>
          m.id === testModelId
            ? { ...m, lastTestedAt: new Date().toISOString(), lastTestStatus: 'error', lastTestError: e.message ?? 'Request failed' }
            : m
        ),
      });
    } finally {
      setTesting(false);
    }
  }, [testModelId, provider, onUpdate]);

  const testedModel = provider.models.find(m => m.id === testModelId);

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 flex flex-col gap-2">
          <AutoSaveField
            value={provider.label}
            onSave={next => patchProvider({ label: next })}
            mono={false}
            placeholder="Label"
          />
          <AutoSaveField
            value={provider.baseUrl}
            onSave={next => patchProvider({ baseUrl: next })}
            placeholder="https://api.example.com/v1"
          />
          <label className="flex flex-col gap-1">
            <select
              value={provider.compatibility}
              onChange={e => changeCompatibility(e.target.value as Compatibility)}
              disabled={compatSaving}
              title="Change which API shape this connection speaks — switch anytime, no need to re-add the connection"
              className="h-7 px-2 rounded-md border bg-background text-foreground text-xs outline-none focus:border-primary w-fit disabled:opacity-50"
            >
              {COMPAT_OPTIONS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>

          {!editingKey ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setEditingKey(true)}
                className="self-start text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {provider.hasApiKey ? 'Change API key' : 'Add API key'}
              </button>
              {provider.hasApiKey && (
                <button
                  onClick={copyApiKey}
                  disabled={copyState === 'copying'}
                  className="self-start text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                >
                  {copyState === 'copied' ? 'Copied ✓' : copyState === 'error' ? 'Copy failed' : copyState === 'copying' ? 'Copying…' : 'Copy API key'}
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <AutoSaveField
                value=""
                onSave={async next => {
                  await patchProvider({ apiKey: next });
                  // Brief pause so the "Saved ✓" indicator is actually
                  // visible before the field collapses back down.
                  setTimeout(() => setEditingKey(false), 1200);
                }}
                type="password"
                placeholder={provider.hasApiKey ? '•••••••• (enter a new key to rotate it)' : 'sk-...'}
              />
              <button
                onClick={() => setEditingKey(false)}
                className="h-9 px-2 text-xs text-muted-foreground hover:bg-accent rounded-md shrink-0"
              >
                Done
              </button>
            </div>
          )}
        </div>
        <button onClick={onDelete} title="Remove provider" className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive shrink-0">
          <DeleteIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={fetchModels}
          disabled={fetching}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md border text-sm hover:bg-accent transition-colors disabled:opacity-50 text-foreground"
        >
          <svg className={cn('w-3.5 h-3.5', fetching && 'animate-spin')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {fetching ? 'Fetching…' : 'Fetch models'}
        </button>
        {provider.lastFetchedAt && !fetchError && (
          <span className="text-xs text-muted-foreground">Last fetched {new Date(provider.lastFetchedAt).toLocaleString()}</span>
        )}
      </div>

      {fetchError && (
        <div className="text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
          {fetchError} — you can still add a model id manually below.
        </div>
      )}

      {provider.models.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          {provider.models.map(m => (
            <div key={m.id} className="flex items-center gap-2 py-1">
              <span
                title={
                  m.lastTestStatus === 'success'
                    ? `Connection OK${m.lastTestedAt ? ' — ' + new Date(m.lastTestedAt).toLocaleString() : ''}`
                    : m.lastTestStatus === 'error'
                      ? (m.lastTestError ?? 'Test failed')
                      : 'Not tested yet'
                }
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  m.lastTestStatus === 'success' && 'bg-green-500',
                  m.lastTestStatus === 'error' && 'bg-destructive',
                  !m.lastTestStatus && 'bg-muted-foreground/30'
                )}
              />
              <span className="flex-1 truncate text-sm text-foreground font-mono">{m.label || m.modelId}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Thinking</span>
                <Toggle checked={m.reasoningEnabled} onChange={() => toggleReasoning(m.id, !m.reasoningEnabled)} />
              </div>
              <Toggle checked={m.isEnabled} onChange={() => toggleModel(m.id, !m.isEnabled)} />
              <button onClick={() => removeModel(m.id)} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive">
                <DeleteIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <ManualModelAdd
        providerId={provider.id}
        onAdded={m => onUpdate({ ...provider, models: [...provider.models.filter(x => x.modelId !== m.modelId), m] })}
      />

      {provider.models.length > 0 && (
        <div className="flex items-center gap-2 border-t pt-2 flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0">Test connection</span>
          <select
            value={testModelId}
            onChange={e => setTestModelId(e.target.value)}
            className="h-7 px-2 rounded-md border bg-background text-foreground text-xs outline-none focus:border-primary max-w-[180px]"
          >
            {provider.models.map(m => (
              <option key={m.id} value={m.id}>{m.label || m.modelId}</option>
            ))}
          </select>
          <button
            onClick={testConnection}
            disabled={testing || !testModelId}
            className="h-7 px-2.5 rounded-md border text-xs hover:bg-accent transition-colors disabled:opacity-50 text-foreground shrink-0"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          {testedModel?.lastTestStatus === 'success' && (
            <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Connected ✓
            </span>
          )}
          {testedModel?.lastTestStatus === 'error' && (
            <span className="flex items-center gap-1.5 text-xs text-destructive truncate max-w-[240px]" title={testedModel.lastTestError ?? undefined}>
              <span className="w-2 h-2 rounded-full bg-destructive inline-block shrink-0" /> {testedModel.lastTestError ?? 'Failed'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ModelProvidersSection() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/user/byok/providers')
      .then(async res => {
        const json = await safeJson(res);
        if (!res.ok) throw new Error(json.error?.message ?? json.error ?? `Failed to load providers (status ${res.status}).`);
        setProviders(json.providers ?? []);
      })
      .catch(e => {
        setLoadError(e.message ?? 'Failed to load providers.');
        setProviders([]); // stop the spinner even on failure
      });
  }, []);

  const updateProvider = useCallback((updated: Provider) => {
    setProviders(prev => (prev ? prev.map(p => (p.id === updated.id ? updated : p)) : prev));
  }, []);

  const deleteProvider = useCallback(async (id: string) => {
    if (!confirm('Remove this provider and all its models?')) return;
    setProviders(prev => (prev ? prev.filter(p => p.id !== id) : prev));
    await fetch(`/api/user/byok/providers/${id}`, { method: 'DELETE' });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-base font-medium text-foreground">BYOK model providers</div>
        <div className="text-sm text-muted-foreground mt-1">
          Add your own provider (base URL + optional API key), fetch its available models, and
          toggle which ones show up in the chat model selector. BYOK models get the exact same
          tools (web search, browser, python, docs) as the built-in models — nothing is gated.
        </div>
      </div>

      {loadError && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      {providers === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {providers.map(p => (
            <ProviderCard key={p.id} provider={p} onUpdate={updateProvider} onDelete={() => deleteProvider(p.id)} />
          ))}
          <AddProviderForm onCreated={p => setProviders(prev => (prev ? [...prev, p] : [p]))} />
        </>
      )}
    </div>
  );
}

type SettingsTab = 'providers' | 'integrations';

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('providers');

  return (
    <div className="flex-1 overflow-y-auto h-full flex flex-col">
      <header className="h-15 border-b px-4 flex items-center gap-4 shrink-0">
        <AutoSidebarPadding className="transition-all h-full flex items-center">
          <span className="text-lg font-semibold text-foreground" style={{ letterSpacing: -0.24 }}>Settings</span>
        </AutoSidebarPadding>
      </header>

      <div className="max-w-2xl w-full mx-auto px-4 pt-4 shrink-0">
        <div className="flex items-center gap-1 border-b">
          <button
            onClick={() => setTab('providers')}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === 'providers' ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Model providers
          </button>
          <button
            onClick={() => setTab('integrations')}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === 'integrations' ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Integrations
          </button>
        </div>
      </div>

      <div className="max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4">
        {tab === 'providers' ? <ModelProvidersSection /> : <IntegrationsSection />}
      </div>
    </div>
  );
}
