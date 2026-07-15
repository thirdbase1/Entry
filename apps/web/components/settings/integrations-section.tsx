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
}

const KNOWN_SERVICES: KnownService[] = [
  {
    service: 'vercel',
    name: 'Vercel',
    hint: 'Personal Access Token — used to deploy this project to your own Vercel account.',
    placeholder: 'Paste your Vercel token',
    tokenUrl: 'https://vercel.com/account/tokens',
    icon: '/integration-logos/vercel.svg',
  },
  {
    service: 'github',
    name: 'GitHub',
    hint: 'Fine-grained personal access token (repo scope) — used to push code to your own repos.',
    placeholder: 'Paste your GitHub token',
    tokenUrl: 'https://github.com/settings/tokens',
    icon: '/integration-logos/github.svg',
  },
  {
    service: 'supabase',
    name: 'Supabase',
    hint: 'Personal access token — used to provision/manage your own Supabase projects.',
    placeholder: 'Paste your Supabase token',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    icon: '/integration-logos/supabase.svg',
  },
  {
    service: 'pxxl',
    name: 'Pxxl',
    hint: 'Scoped API key from Dashboard > API Keys — used to deploy to your own Pxxl workspace.',
    placeholder: 'Paste your Pxxl API key',
    tokenUrl: 'https://pxxl.app/dashboard/api-keys',
    icon: '/integration-logos/pxxl.png',
  },
  {
    service: 'sendbyte',
    name: 'Sendbyte',
    hint: 'API key — used to send transactional email through your own Sendbyte account.',
    placeholder: 'Paste your Sendbyte API key',
    tokenUrl: 'https://app.sendbyte.africa/emails',
    icon: '/integration-logos/sendbyte.svg',
    iconBg: 'bg-[#054525]',
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
          {KNOWN_SERVICES.map(def => (
            <IntegrationCard
              key={def.service}
              def={def}
              connected={findMeta(def.service)}
              onSaved={meta => setCredentials(prev => [meta, ...(prev ?? []).filter(c => !(c.service === meta.service && c.label === meta.label))])}
              onDisconnected={reload}
            />
          ))}

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
