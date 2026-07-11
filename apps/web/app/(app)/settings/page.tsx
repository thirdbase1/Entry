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
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlusIcon, DeleteIcon } from '@blocksuite/icons/rc';
import { AutoSidebarPadding } from '@/components/layout/auto-sidebar-padding';
import { cn } from '@/lib/utils';

/** Parses a fetch Response as JSON, tolerating empty/non-JSON bodies (e.g. a
 * crashed serverless function with no body) instead of throwing a raw
 * "Unexpected end of JSON input" at the user. */
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return { error: `Server returned an empty response (status ${res.status}).` };
  try {
    return JSON.parse(text);
  } catch {
    return { error: `Server returned an unexpected response (status ${res.status}).` };
  }
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Tiny inline-edit input that autosaves itself on blur AND ~800ms after the
 * user stops typing — no separate "Save" button, no state that only lives
 * in memory. `onSave` is expected to PATCH the backend and throw on
 * failure; a failed save reverts to the last-known-good value so the UI
 * never silently claims something persisted when it didn't. */
function AutoSaveField({
  value,
  onSave,
  placeholder,
  type = 'text',
  mono = true,
  mask = false,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  mask?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<SaveState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(value);

  useEffect(() => {
    // Reflect external updates (e.g. a fresh GET on mount) without
    // clobbering in-flight edits.
    if (state === 'idle') {
      setDraft(value);
      lastSavedRef.current = value;
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(
    async (next: string) => {
      if (next === lastSavedRef.current) return;
      setState('saving');
      try {
        await onSave(next);
        lastSavedRef.current = next;
        setState('saved');
        setTimeout(() => setState(s => (s === 'saved' ? 'idle' : s)), 1500);
      } catch {
        setDraft(lastSavedRef.current); // revert — don't pretend it saved
        setState('error');
        setTimeout(() => setState(s => (s === 'error' ? 'idle' : s)), 2500);
      }
    },
    [onSave]
  );

  const handleChange = (next: string) => {
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(next), 800);
  };

  const handleBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    commit(draft);
  };

  return (
    <div className="relative flex-1">
      <input
        type={type}
        value={draft}
        onChange={e => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={cn(
          'h-9 px-3 pr-14 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary w-full',
          mono && 'font-mono'
        )}
      />
      <span
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 text-[11px] pointer-events-none transition-opacity',
          state === 'idle' ? 'opacity-0' : 'opacity-100',
          state === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : state === 'error' ? 'Failed' : ''}
      </span>
    </div>
  );
}

type Compatibility = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE';

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
];

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'w-8 h-4.5 rounded-full relative transition-colors shrink-0 disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-background transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}

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

  /** PATCHes the provider connection itself (label / base URL / API key) —
   * used by the AutoSaveField instances below. Throws on a non-OK response
   * so AutoSaveField reverts the input instead of showing a false "Saved". */
  const patchProvider = useCallback(
    async (patch: { label?: string; baseUrl?: string; apiKey?: string }) => {
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

  const compatLabel = COMPAT_OPTIONS.find(c => c.value === provider.compatibility)?.label ?? provider.compatibility;

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
          <div className="text-xs text-muted-foreground">{compatLabel}</div>

          {!editingKey ? (
            <button
              onClick={() => setEditingKey(true)}
              className="self-start text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {provider.hasApiKey ? 'Change API key' : 'Add API key'}
            </button>
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
    </div>
  );
}

export default function SettingsPage() {
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
    <div className="flex-1 overflow-y-auto h-full flex flex-col">
      <header className="h-15 border-b px-4 flex items-center gap-4 shrink-0">
        <AutoSidebarPadding className="transition-all h-full flex items-center">
          <span className="text-lg font-semibold text-foreground" style={{ letterSpacing: -0.24 }}>Settings</span>
        </AutoSidebarPadding>
      </header>

      <div className="max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4">
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
    </div>
  );
}
