'use client';

/**
 * "Integrations" tab — lets a user paste their own token for a deploy
 * target (Vercel, GitHub, Supabase, Pxxl, Sendbyte, or anything custom)
 * instead of dictating it into chat. Rides on the exact same encrypted
 * vault (@entry/agent/lib/credential-vault, service+label+value) the AI's
 * save_credential/inject_credential tools already use — once saved here,
 * the agent can `inject_credential` it straight into a deploy without the
 * user typing the token into a shell command or a chat message at all.
 *
 * Token-only by design (no OAuth apps) — every one of these providers
 * supports a personal/scoped API token for exactly this kind of
 * server-to-server automation, so that's all this needs.
 */
import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, DeleteIcon } from '@blocksuite/icons/rc';
import { AutoSaveField, safeJson } from './shared';

interface KnownService {
  service: string;
  name: string;
  hint: string;
  placeholder: string;
  tokenUrl: string;
  /** Real brand logo, served from /public/integration-logos — pulled
   *  straight from each provider's own site/docs (not AI-generated). */
  icon: string;
  /** Some marks (e.g. Pxxl's raster wordmark) look better on a subtle
   *  tinted tile than bare on the card background. */
  iconBg?: string;
  /** Has a real Vercel Connect connector (github/entry-github,
   *  vercel/entry-vercel-internal, supabase/entry-supabase) — render a
   *  one-click "Connect" OAuth button instead of a token-paste field.
   *  Pxxl and Sendbyte have no such connector (no managed type, and
   *  neither runs an OAuth server for a Custom OAuth connector), so
   *  they stay token-only. */
  oauth?: boolean;
}

const KNOWN_SERVICES: KnownService[] = [
  {
    service: 'vercel',
    name: 'Vercel',
    hint: 'Connect your own Vercel account — the agent deploys as you, with a short-lived token it never stores.',
    placeholder: 'Paste your Vercel token',
    tokenUrl: 'https://vercel.com/account/tokens',
    icon: '/integration-logos/vercel.svg',
    oauth: true,
  },
  {
    service: 'github',
    name: 'GitHub',
    hint: 'Connect your own GitHub account — the agent pushes/opens PRs as you, with a short-lived token it never stores.',
    placeholder: 'Paste your GitHub token',
    tokenUrl: 'https://github.com/settings/tokens',
    icon: '/integration-logos/github.svg',
    oauth: true,
  },
  {
    service: 'supabase',
    name: 'Supabase',
    hint: 'Connect your own Supabase account — the agent provisions/manages your own projects, with a short-lived token it never stores.',
    placeholder: 'Paste your Supabase token',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    icon: '/integration-logos/supabase.svg',
    oauth: true,
  },
  {
    service: 'pxxl',
    name: 'Pxxl',
    hint: 'Scoped API key from Dashboard > API Keys — used to deploy to your own Pxxl workspace.',
    placeholder: 'Paste your Pxxl API key',
    tokenUrl: 'https://pxxl.app/dashboard/keys',
    // Pxxl's actual app-icon mark (purple ringed-planet on white),
    // pulled from their own apple-touch-icon — not the plain white
    // navbar wordmark, which is invisible outside a dark background.
    icon: '/integration-logos/pxxl.png',
  },
  {
    service: 'sendbyte',
    name: 'Sendbyte',
    hint: 'API key — used to send transactional email through your own Sendbyte account.',
    placeholder: 'Paste your Sendbyte API key',
    tokenUrl: 'https://app.sendbyte.africa/keys/',
    icon: '/integration-logos/sendbyte.svg',
  },
];

interface CredentialMeta {
  service: string;
  label: string;
  updatedAt: string;
}

function IntegrationCard({
  def,
  connected,
  onSaved,
  onDisconnected,
}: {
  def: KnownService;
  connected: CredentialMeta | undefined;
  onSaved: (meta: CredentialMeta) => void;
  onDisconnected: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const save = useCallback(
    async (value: string) => {
      const res = await fetch('/api/user/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: def.service, value }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to save token');
      onSaved({ service: def.service, label: 'default', updatedAt: new Date().toISOString() });
      setTimeout(() => setEditing(false), 1200);
    },
    [def.service, onSaved]
  );

  const disconnect = useCallback(async () => {
    if (!confirm(`Disconnect ${def.name}? Anything using this token (deploys, chat) will stop working until you reconnect.`)) return;
    setDisconnecting(true);
    try {
      await fetch(`/api/user/integrations/${encodeURIComponent(def.service)}`, { method: 'DELETE' });
      onDisconnected();
    } finally {
      setDisconnecting(false);
    }
  }, [def.service, def.name, onDisconnected]);

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 flex items-start gap-3">
          <div
            className={
              'w-9 h-9 rounded-md border shrink-0 flex items-center justify-center overflow-hidden ' +
              (def.iconBg ?? 'bg-background')
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny static brand marks from /public, not worth next/image's remote-pattern config */}
            <img src={def.icon} alt={`${def.name} logo`} className="w-6 h-6 object-contain" />
          </div>
          <div className="flex-1 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{def.name}</span>
            <span
              className={
                connected
                  ? 'text-[11px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary'
                  : 'text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground'
              }
            >
              {connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">{def.hint}</div>
          </div>
        </div>
        {connected && (
          <button
            onClick={disconnect}
            disabled={disconnecting}
            title="Disconnect"
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive shrink-0 disabled:opacity-50"
          >
            <DeleteIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {!editing ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEditing(true)}
            className="self-start text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            {connected ? 'Replace token' : 'Add token'}
          </button>
          <a
            href={def.tokenUrl}
            target="_blank"
            rel="noreferrer"
            className="self-start text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Get a token
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <AutoSaveField value="" onSave={save} type="password" placeholder={def.placeholder} mono />
          <button
            onClick={() => setEditing(false)}
            className="h-9 px-2 text-xs text-muted-foreground hover:bg-accent rounded-md shrink-0"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function OAuthIntegrationCard({
  def,
  connected,
  onChanged,
}: {
  def: KnownService;
  connected: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    // GitHub (2026-07-18): direct GitHub OAuth now, not Vercel Connect --
    // Connect's github connector never actually completed a per-user grant
    // no matter how many times the install was redone. This route has a
    // real redirect-back callback on our own domain, so a plain top-level
    // navigation is all that's needed -- no popup/poll hack.
    if (def.service === 'github') {
      window.location.href = '/api/integrations/github-oauth/start';
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/connect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: def.service }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to start connection');
      window.location.href = json.url;
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
      setBusy(false);
    }
  }, [def.service, onChanged]);

  const disconnect = useCallback(async () => {
    if (!confirm(`Disconnect ${def.name}? Anything using this connection (deploys, chat) will stop working until you reconnect.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/connect/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: def.service }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to disconnect');
      onChanged();
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, [def.service, def.name, onChanged]);

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 flex items-start gap-3">
          <div
            className={
              'w-9 h-9 rounded-md border shrink-0 flex items-center justify-center overflow-hidden ' +
              (def.iconBg ?? 'bg-background')
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny static brand marks from /public, not worth next/image's remote-pattern config */}
            <img src={def.icon} alt={`${def.name} logo`} className="w-6 h-6 object-contain" />
          </div>
          <div className="flex-1 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{def.name}</span>
              <span
                className={
                  connected
                    ? 'text-[11px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary'
                    : 'text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground'
                }
              >
                {connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">{def.hint}</div>
          </div>
        </div>
        {connected && (
          <button
            onClick={disconnect}
            disabled={busy}
            title="Disconnect"
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive shrink-0 disabled:opacity-50"
          >
            <DeleteIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}

      {!connected && (
        <button
          onClick={connect}
          disabled={busy}
          className="self-start h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : `Connect ${def.name}`}
        </button>
      )}
    </div>
  );
}

function CustomIntegrationCard({
  meta,
  onDisconnected,
}: {
  meta: CredentialMeta;
  onDisconnected: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = useCallback(async () => {
    if (!confirm(`Disconnect ${meta.service}?`)) return;
    setDisconnecting(true);
    try {
      await fetch(`/api/user/integrations/${encodeURIComponent(meta.service)}?label=${encodeURIComponent(meta.label)}`, {
        method: 'DELETE',
      });
      onDisconnected();
    } finally {
      setDisconnecting(false);
    }
  }, [meta.service, meta.label, onDisconnected]);

  return (
    <div className="border rounded-lg p-4 flex items-center justify-between gap-2 bg-card">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground capitalize">{meta.service}</span>
          {meta.label !== 'default' && <span className="text-xs text-muted-foreground">({meta.label})</span>}
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">Connected</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Saved from chat — {new Date(meta.updatedAt).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={disconnect}
        disabled={disconnecting}
        title="Disconnect"
        className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive shrink-0 disabled:opacity-50"
      >
        <DeleteIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

function AddCustomIntegrationForm({ onSaved }: { onSaved: (meta: CredentialMeta) => void }) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!service.trim() || !value.trim()) {
      setError('Service name and token are both required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/user/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: service.trim().toLowerCase(), value }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to save token');
      onSaved({ service: service.trim().toLowerCase(), label: 'default', updatedAt: new Date().toISOString() });
      setOpen(false);
      setService('');
      setValue('');
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }, [service, value, onSaved]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 h-9 rounded-md text-sm border hover:bg-accent transition-colors text-foreground"
      >
        <PlusIcon className="w-4 h-4" />
        Add another integration
      </button>
    );
  }

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-card">
      <div className="text-sm font-medium text-foreground">New integration</div>
      <input
        value={service}
        onChange={e => setService(e.target.value)}
        placeholder="Service name, e.g. netlify, railway, stripe"
        className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary w-full"
      />
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        type="password"
        placeholder="Token / API key"
        className="h-9 px-3 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary w-full font-mono"
      />
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={submit}
          disabled={saving}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function IntegrationsSection() {
  const [credentials, setCredentials] = useState<CredentialMeta[] | null>(null);
  const [connectStatus, setConnectStatus] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch('/api/user/integrations')
      .then(async res => {
        const json = await safeJson(res);
        if (!res.ok) throw new Error(json.error?.message ?? json.error ?? `Failed to load integrations (status ${res.status}).`);
        setCredentials(json.credentials ?? []);
      })
      .catch(e => {
        setLoadError(e.message ?? 'Failed to load integrations.');
        setCredentials([]);
      });

    fetch('/api/integrations/connect/status')
      .then(async res => {
        const json = await safeJson(res);
        if (res.ok) setConnectStatus(json.connected ?? {});
      })
      .catch(() => {
        // Non-fatal — OAuth cards just show "Not connected" until this loads.
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const findMeta = (service: string) => credentials?.find(c => c.service === service && c.label === 'default');
  const knownServiceNames = new Set(KNOWN_SERVICES.map(s => s.service));
  const customCreds = (credentials ?? []).filter(c => !knownServiceNames.has(c.service));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-base font-medium text-foreground">Integrations</div>
        <div className="text-sm text-muted-foreground mt-1">
          Connect your own accounts with a personal API token — no OAuth app, nothing to authorize.
          Once saved, the agent can deploy, push code, or send email through YOUR account instead of a
          shared one. Everything here is encrypted at rest and never shown back once saved.
        </div>
      </div>

      {loadError && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      {credentials === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {KNOWN_SERVICES.map(def =>
            def.oauth ? (
              <OAuthIntegrationCard
                key={def.service}
                def={def}
                connected={Boolean(connectStatus[def.service])}
                onChanged={reload}
              />
            ) : (
              <IntegrationCard
                key={def.service}
                def={def}
                connected={findMeta(def.service)}
                onSaved={meta => setCredentials(prev => [meta, ...(prev ?? []).filter(c => !(c.service === meta.service && c.label === meta.label))])}
                onDisconnected={reload}
              />
            )
          )}

          {customCreds.map(meta => (
            <CustomIntegrationCard key={`${meta.service}:${meta.label}`} meta={meta} onDisconnected={reload} />
          ))}

          <AddCustomIntegrationForm
            onSaved={meta => setCredentials(prev => [meta, ...(prev ?? []).filter(c => !(c.service === meta.service && c.label === meta.label))])}
          />
        </>
      )}
    </div>
  );
}
