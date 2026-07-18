'use client';

import { useState } from 'react';
import Image from 'next/image';
import { getKnownService } from '@/lib/integration-services';

interface IntegrationConnectCardProps {
  service: string;
  connectMode: 'oauth' | 'token';
  toolCallId: string;
  onSend?: (text: string) => void;
  /** Derived from later message history (see message-renderer.tsx /
   *  direct-chat-interface.tsx's findConnectResolution) — this card
   *  remounts fresh on every page load (OAuth is a full top-level
   *  redirect), so its own `resolved` useState never survives the round
   *  trip. Seeding from history is what actually makes the card show
   *  "connected" with no buttons after a real reconnect, instead of
   *  resetting back to the unconnected prompt every time. */
  initialResolved?: 'connected' | 'skipped';
  /** 2026-07-18: distinguishes "never connected at all" from "connected,
   *  but this ONE repo isn't in entry-github's installation yet" (see
   *  inject_credential.ts's isGithubRepoAccessFailure). Same OAuth flow
   *  under the hood either way (github.com/apps/entry-github/installations/new
   *  doubles as both install AND edit-installed-repos), just different
   *  copy/button label so the user isn't told to "connect" something
   *  that's already connected. */
  reason?: 'repo_not_installed';
}

/**
 * Inline "you need to connect X" card, rendered in the chat itself
 * instead of the model telling the user in prose to go find Settings >
 * Integrations (2026-07-18). See message-renderer.tsx for how this gets
 * picked based on a tool result's `needsConnect` field.
 *
 * OAuth services (github/vercel/supabase): Connect opens the real
 * one-click flow (a full top-level navigation — required for GitHub/
 * Vercel's own login pages, can't be an iframe) with a `returnTo` back
 * to THIS exact chat, so the OAuth callback redirects here and
 * auto-sends "Connected <service>." (see chat-interface.tsx's
 * integration-callback effect). Cancel sends "skip" immediately,
 * client-side, no navigation needed.
 *
 * Token services (pxxl/sendbyte/custom): Connect reveals a password
 * input right in the card; submitting POSTs straight to the existing
 * credential vault endpoint and then sends "Connected <service>." itself
 * — no page navigation at all, so no returnTo plumbing needed for this
 * mode.
 */
export function IntegrationConnectCard({ service, connectMode, toolCallId, onSend, initialResolved, reason }: IntegrationConnectCardProps) {
  const known = getKnownService(service);
  const name = known?.name ?? service.charAt(0).toUpperCase() + service.slice(1);
  const [resolved, setResolved] = useState<'connecting' | 'connected' | 'skipped' | null>(initialResolved ?? null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenValue, setTokenValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCancel = () => {
    if (resolved) return;
    setResolved('skipped');
    onSend?.('skip');
  };

  const handleOAuthConnect = () => {
    if (resolved) return;
    setResolved('connecting');
    const returnTo = encodeURIComponent(window.location.pathname);
    if (service === 'github') {
      window.location.href = `/api/integrations/github-oauth/start?returnTo=${returnTo}`;
      return;
    }
    setBusy(true);
    fetch('/api/integrations/connect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, returnTo: window.location.pathname }),
    })
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to start connection');
        window.location.href = json.url;
      })
      .catch(e => {
        setError(e.message ?? 'Something went wrong');
        setResolved(null);
        setBusy(false);
      });
  };

  const handleTokenSave = async () => {
    if (!tokenValue.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/user/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, value: tokenValue.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.error ?? 'Failed to save token');
      setResolved('connected');
      onSend?.(`Connected ${name}.`);
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  if (resolved === 'skipped') {
    return (
      <div key={toolCallId} className="rounded-lg border border-border bg-card w-full max-w-sm p-3 text-sm text-muted-foreground">
        Skipped connecting {name}.
      </div>
    );
  }
  if (resolved === 'connected') {
    return (
      <div key={toolCallId} className="rounded-lg border border-border bg-card w-full max-w-sm p-3 text-sm text-foreground">
        {reason === 'repo_not_installed' ? `${name} repo access updated.` : `${name} connected.`}
      </div>
    );
  }

  return (
    <div key={toolCallId} className="rounded-lg border border-border bg-card w-full max-w-sm p-4 space-y-3">
      <div className="flex items-center gap-2">
        {known?.icon && (
          <div className={known.iconBg ? 'rounded-md p-1' : undefined} style={known.iconBg ? { backgroundColor: known.iconBg } : undefined}>
            <Image src={known.icon} alt={name} width={22} height={22} />
          </div>
        )}
        <div className="text-sm font-medium text-foreground">
          {reason === 'repo_not_installed' ? `${name} doesn't have access to this repo yet` : `${name} isn't connected yet`}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {reason === 'repo_not_installed'
          ? `This repository isn't in ${name}'s selected-repos list yet. Add it in one click — no need to dig through GitHub's own settings.`
          : connectMode === 'oauth'
            ? `Connect your ${name} account so the agent can continue.`
            : `Paste an API token for ${name} so the agent can continue.`}
      </p>

      {connectMode === 'token' && showTokenInput && (
        <input
          type="password"
          autoFocus
          value={tokenValue}
          onChange={e => setTokenValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleTokenSave();
          }}
          placeholder={known?.placeholder ?? `Paste your ${name} token`}
          className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm"
        />
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="flex gap-2">
        <button
          onClick={handleCancel}
          disabled={busy}
          className="h-9 px-4 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent disabled:opacity-50"
        >
          Cancel
        </button>
        {connectMode === 'oauth' ? (
          <button
            onClick={handleOAuthConnect}
            disabled={busy || resolved === 'connecting'}
            className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {resolved === 'connecting' ? 'Connecting…' : reason === 'repo_not_installed' ? 'Manage repo access' : `Connect ${name}`}
          </button>
        ) : showTokenInput ? (
          <button
            onClick={handleTokenSave}
            disabled={busy || !tokenValue.trim()}
            className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save & connect'}
          </button>
        ) : (
          <button
            onClick={() => setShowTokenInput(true)}
            className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Connect {name}
          </button>
        )}
      </div>
    </div>
  );
}
