'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DirectChatInterface } from './direct-chat-interface';
import { DEFAULT_MODEL_ID, useModelOptions } from './chat-config';
import { toast } from '@/lib/toast';
import type { IntegrationCallback } from './integration-callback-reader';

interface ChatInterfaceProps {
  /** Existing chat sessionId, if resuming a saved chat. */
  sessionId?: string;
  placeholder?: string;
  placeholderTitle?: string;
  className?: string;
  headerContent?: React.ReactNode;
  /** Initial message to send immediately (e.g. from a ?msg= query param). */
  initialMessage?: string;
  /** Preselect a model for a brand-new chat (e.g. ?model=byok:xyz after the
   *  cross-bucket redirect below) — takes priority over the last-used
   *  localStorage value, since the user just explicitly picked this one. */
  initialModel?: string;
  /** In-chat connect card (2026-07-18): set when this chat was just
   *  reopened via an OAuth connect redirect (github-oauth/callback or
   *  connect/start's returnTo) — triggers an automatic "Connected X."/
   *  error follow-up message so the agent resumes without the user
   *  retyping anything. */
  integrationCallback?: IntegrationCallback;
}

/** localStorage key for the user's last-selected model, so a BYOK choice
 *  (or any model choice) persists across brand-new chats instead of
 *  resetting to the default every time. */
const LAST_MODEL_STORAGE_KEY = 'entry:lastSelectedModel';

async function fetchSnapshot(sessionId: string) {
  const res = await fetch(`/api/chats/${sessionId}`);
  if (!res.ok) return null;
  return res.json() as Promise<{ events?: unknown; cursor?: unknown; byokModelId?: string | null; requestedModel?: string | null }>;
}

/**
 * RETIRED (2026-07-22): this used to be a dual-runtime wrapper — every
 * chat picked between eve's own in-process session runtime (the original
 * "default model" path) and this same-origin /api/direct/chat path
 * (BYOK + explicit Gateway model picks), forking on `isDirect` computed
 * below. eve is now fully decommissioned:
 * - /api/direct/chat already resolves the same catalog-picked default
 *   model eve's root agent used to when no explicit model is picked (see
 *   that route's `resolveModelIdForProvider('anthropic')` fallback), so
 *   it has full feature parity with eve's root agent.
 * - The only 4 chat rows left anywhere in the database that predated this
 *   migration (all disposable July-10 test chats, zero real content) were
 *   removed outright.
 * - That route now also backfills its resolved default model id back
 *   into `requestedModel` on every row it creates, so no future row can
 *   ever again look like a "legacy eve" row on a later page load.
 * `withEve()` (next.config.ts), the in-process eve mount it required, and
 * the ~500 lines of eve-runtime-specific rendering/recovery logic that
 * used to live in this file (ChatInterfaceInner, useThrottledEveAgent,
 * eve-reconcile.ts) are deleted along with it — this component is now a
 * thin loader that resolves the resumed chat's model + attaches it, then
 * renders DirectChatInterface unconditionally.
 */
export function ChatInterface({
  sessionId,
  placeholder = 'What are your thoughts?',
  placeholderTitle = 'What can I help you with?',
  className = '',
  headerContent,
  initialMessage,
  initialModel,
  integrationCallback,
}: ChatInterfaceProps) {
  const router = useRouter();
  const [initial, setInitial] = useState<{ events?: unknown; cursor?: unknown; byokModelId?: string | null; requestedModel?: string | null } | null>(
    sessionId ? null : {}
  );

  // Model selection lives here (not in ChatInput) so a resumed chat's
  // stored model can be seeded before DirectChatInterface ever mounts.
  // For a brand-new chat, initializes from the user's last-used model
  // (persisted in localStorage) instead of always falling back to
  // DEFAULT_MODEL_ID — otherwise a BYOK selection "didn't stick": every
  // new chat silently reverted to the default gateway model even though
  // the BYOK provider/key itself was still saved server-side. A resumed
  // chat still gets overridden from its stored byokModelId below, same
  // as before.
  const [model, setModelState] = useState<string>(() => {
    if (sessionId) return DEFAULT_MODEL_ID;
    if (initialModel) return initialModel;
    if (typeof window === 'undefined') return DEFAULT_MODEL_ID;
    try {
      return window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) || DEFAULT_MODEL_ID;
    } catch {
      return DEFAULT_MODEL_ID;
    }
  });
  // Tracks whether the LIVE picker was actually touched by the user during
  // this component's lifetime, as opposed to just being seeded from a
  // resumed chat's stored model (see the seeding effect below, which
  // deliberately bypasses this via setModelState directly). Needed so the
  // cross-bucket-redirect effect further down can't misfire during the
  // one-render gap between mount (model = DEFAULT_MODEL_ID) and that
  // seeding effect settling `model` to match `initial` — without this
  // guard, a freshly-opened BYOK/Gateway chat would see model=DEFAULT for
  // one render while initial.byokModelId is already set, look exactly
  // like a real cross-bucket pick, and wrongly redirect away immediately.
  const userChangedModelRef = useRef(false);
  const setModel = useCallback((next: string) => {
    userChangedModelRef.current = true;
    setModelState(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, next);
    } catch {
      // localStorage can throw in private-browsing/quota-exceeded cases —
      // persistence is a nice-to-have, never worth crashing the chat over.
    }
  }, []);
  const modelInitializedRef = useRef(false);

  // FIXED (2026-07-21, real live incident: a brand-new chat "stops
  // instantly" with no visible response and never even creates a chat
  // row -- root-caused via direct DB inspection, since nothing was
  // throwing server-side at all to explain it). The `model` state above
  // seeds itself from localStorage's last-selected value with ZERO
  // validation -- if that was a `byok:<modelRowId>` pointing at a BYOK
  // provider model the user has since deleted (e.g. after rotating/
  // replacing their API keys, exactly as reported), a brand-new chat
  // sends that dead id straight to /api/direct/chat as byokModelId.
  // resolveByokModel throws "BYOK model not found, disabled, or not
  // owned by the current user" BEFORE preSave ever runs (that awaited
  // resolve happens earlier in the route than the chat-row create/
  // update), so the row is never created at all -- exactly matching
  // "the chat doesn't even exist" rather than "existed then got
  // deleted." Once the live BYOK catalog has actually loaded, silently
  // fall back to the default model instead of ever sending a
  // known-dead id. Only runs for a brand-new, not-yet-sent chat (never
  // yanks the model out from under an existing/in-flight thread), and
  // only once so it never fights a live user pick made afterward.
  const staleModelCheckedRef = useRef(false);
  const liveModelOptions = useModelOptions();
  useEffect(() => {
    if (sessionId) return; // only a brand-new chat can have a stale seed
    if (staleModelCheckedRef.current) return;
    if (userChangedModelRef.current) return; // user already picked live -- don't override
    if (!model.startsWith('byok:')) return;
    if (liveModelOptions.length === 0) return; // catalog hasn't loaded yet -- wait for it
    const stillValid = liveModelOptions.some(o => o.value === model);
    if (stillValid) {
      staleModelCheckedRef.current = true;
      return;
    }
    staleModelCheckedRef.current = true;
    console.warn('[chat] stale localStorage model no longer exists, falling back to default:', model);
    setModelState(DEFAULT_MODEL_ID);
    try {
      window.localStorage.removeItem(LAST_MODEL_STORAGE_KEY);
    } catch {
      // best-effort cleanup only
    }
  }, [sessionId, model, liveModelOptions]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSnapshot(sessionId).then(snap => {
      if (!cancelled) setInitial(snap ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (modelInitializedRef.current) return;
    if (!initial) return;
    modelInitializedRef.current = true;
    // setModelState directly, NOT setModel — this is seeding the picker
    // to reflect a resumed chat's already-locked-in model, not a real
    // user preference change. Using setModel here used to also (a)
    // overwrite the user's "last used model" localStorage default just
    // from opening an old chat, and (b) incorrectly flip
    // userChangedModelRef and defeat its entire purpose above.
    //
    // FIXED (2026-07-15, explicit user report: "model I choose doesn't
    // save even if I reload"): this only ever seeded from the chat's
    // SERVER-persisted byokModelId/requestedModel, which only gets written
    // once a turn actually completes on that chat. An existing-but-empty
    // chat (sessionId already assigned, e.g. right after creation, or one
    // where the user picked a model but hasn't sent a message with it
    // yet) has neither field set — and this component's very own model
    // initializer above (`useState`) deliberately returns DEFAULT_MODEL_ID
    // whenever `sessionId` is truthy, skipping localStorage entirely on
    // the assumption THIS effect would always settle the real value. For
    // that specific "existing chat, no model recorded yet" case it never
    // did, so the picker silently reset to Default on every reload
    // regardless of what was saved in localStorage. Now falls back to the
    // same last-used-model localStorage read the brand-new-chat path
    // already uses, instead of leaving it stuck on Default.
    if (initial.byokModelId) {
      setModelState(`byok:${initial.byokModelId}`);
    } else if (initial.requestedModel) {
      setModelState(`gateway:${initial.requestedModel}`);
    } else if (typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(LAST_MODEL_STORAGE_KEY);
        if (saved) setModelState(saved);
      } catch {
        // localStorage can throw in private-browsing/quota-exceeded cases —
        // falling through to whatever `model` already is (DEFAULT_MODEL_ID)
        // is a fine degrade, never worth crashing the chat over.
      }
    }
  }, [initial]);

  // A resumed thread's bucket (which model row it was created under)
  // can't retroactively change — a live model switch on an EXISTING
  // thread forks into a brand-new chat under the newly-picked model
  // instead of silently no-op'ing or corrupting the resumed thread.
  // `rowIsDirect`/`crossedBucket` are near-permanently true/false now
  // that eve is retired (kept only as defensive protection: if some
  // never-migrated row ever did show up with neither field set, this
  // still degrades to a friendly redirect instead of a crash).
  const rowIsDirect = !initial ? null : sessionId ? !!(initial.byokModelId || initial.requestedModel) : null;
  const liveIsDirect = true;
  const isDirect = rowIsDirect === null ? liveIsDirect : rowIsDirect;
  const crossedBucket = rowIsDirect !== null && rowIsDirect !== liveIsDirect;

  useEffect(() => {
    if (!initial) return; // still loading — nothing to cross yet
    if (!crossedBucket) return;
    if (!userChangedModelRef.current) return; // seeding-gap guard, see above
    toast("Switching to Default here starts a new chat — this thread can't change models.");
    const params = new URLSearchParams({ model });
    router.push(`/chats?${params.toString()}`);
  }, [initial, crossedBucket, liveIsDirect, model, router]);

  if (!initial) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  if (!isDirect) {
    // Defensive only — should be unreachable now that every row this app
    // creates always has a byokModelId or requestedModel set (see
    // /api/direct/chat's preSave + default-model backfill).
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>This conversation is from a retired chat runtime and can no longer be opened here.</p>
        <button className="underline" onClick={() => router.push('/chats')}>
          Start a new chat
        </button>
      </div>
    );
  }

  // While `crossedBucket` (redirect in flight above), keep rendering THIS
  // row under its original, still-true model — never the live pick that
  // doesn't apply to it — so there's no flash of a half-switched state
  // before the redirect lands.
  const byokModelId = crossedBucket
    ? initial.byokModelId ?? undefined
    : model.startsWith('byok:')
      ? model.slice('byok:'.length)
      : undefined;
  const requestedModel = crossedBucket
    ? initial.requestedModel ?? undefined
    : model.startsWith('gateway:')
      ? model.slice('gateway:'.length)
      : undefined;

  return (
    <DirectChatInterface
      key={`direct-${sessionId ?? 'new'}`}
      sessionId={sessionId}
      byokModelId={byokModelId}
      requestedModel={requestedModel}
      model={model}
      setModel={setModel}
      placeholder={placeholder}
      placeholderTitle={placeholderTitle}
      className={className}
      headerContent={headerContent}
      initialMessage={initialMessage}
      integrationCallback={integrationCallback}
    />
  );
}
