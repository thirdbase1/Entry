'use client';

/**
 * Shared preview status polling (2026-07-11 original ask: "the preview is
 * having issues, it should always connect"). Lives in ChatPageHeader
 * (always mounted while the chat page is open), NOT inside
 * ChatPreviewPanel (only mounted while the panel is actually open) -- so
 * a broken preview gets noticed and the UI badge lights up whether or not
 * the user ever opens the panel at all.
 *
 * REMOVED (2026-07-15, explicit user request: "do the sandbox not to
 * ever automatically send this" -- re: the injected chat message "The
 * app preview isn't connecting (status: stopped)..."): this used to
 * escalate a real, sustained "unavailable" streak by injecting a
 * synthetic message into the LIVE conversation via the same send path a
 * real user turn uses (see chat-auto-fix-context.tsx). That's gone now,
 * full stop -- confirmed root cause of a second, related bug ("why does
 * AI tool calling stop instantly"): a brand-new chat's first turn
 * routinely does real setup work for well over the old stuck-threshold
 * before any dev server exists yet to preview, so this was firing that
 * synthetic send WHILE the turn's own tool calls were still streaming,
 * aborting them. Removing the auto-send entirely (rather than just
 * tuning the threshold again) is the actual fix the user asked for: no
 * amount of retuning removes the risk of ever firing mid-turn again.
 *
 * What's left, deliberately narrow:
 *   - Poll the preview status endpoint so the header "Preview" button and
 *     panel can show live state (booting / connected / not connected).
 *   - For direct/BYOK chats only (a real reachable sandbox, restarting it
 *     never touches the chat/conversation at all): one silent self-heal
 *     restart attempt after a sustained miss, same as before.
 *   - No message is ever injected into the chat automatically, for any
 *     chat type, under any condition. If the user wants the agent to look
 *     at it, they ask -- same as clicking "Restart" in the panel, which
 *     also never touches the chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoFixSend } from './chat-auto-fix-context';

export type PreviewStatus = {
  status: string;
  available: boolean;
  url?: string | null;
  port?: number | null;
  reason?: string | null;
  error?: string | null;
  isDirect: boolean;
  requiresAgentAction: boolean;
};

const POLL_INTERVAL_MS = 4000;
// Consecutive unavailable polls before attempting the silent self-heal
// restart (direct/BYOK only) -- 24s, enough that a normal boot gap never
// triggers it.
const STUCK_THRESHOLD = 6;
// Grace period after the chat's first-ever turn starts before the stuck
// counter is even allowed to run -- a fresh sandbox/dev-server on a
// brand-new chat needs real time to exist at all, let alone boot.
const INITIAL_GRACE_MS = 45 * 1000;

export function usePreviewAutoFix(sessionId: string | undefined) {
  const [state, setState] = useState<PreviewStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unavailableStreakRef = useRef(0);
  const selfHealAttemptedRef = useRef(false);
  const firstSeenAtRef = useRef<number | null>(null);
  const autoFix = useAutoFixSend();
  const hasMessages = autoFix?.hasMessages ?? false;

  const restart = useCallback(async () => {
    if (!sessionId) return null;
    const res = await fetch(`/api/chats/${sessionId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    return res.json().catch(() => null);
  }, [sessionId]);

  const poll = useCallback(async () => {
    // Nothing to preview on a chat with no messages yet -- don't even ask.
    if (!sessionId || !hasMessages) return;
    if (firstSeenAtRef.current === null) firstSeenAtRef.current = Date.now();
    try {
      const res = await fetch(`/api/chats/${sessionId}/preview`);
      if (!res.ok) return;
      const data = (await res.json()) as PreviewStatus;
      setState(data);

      if (data.available) {
        unavailableStreakRef.current = 0;
        selfHealAttemptedRef.current = false;
        return;
      }

      // A turn is actively streaming right now -- a tool call legitimately
      // rebuilding/restarting the dev server is expected downtime, not a
      // stuck sandbox. Don't count it toward the streak.
      if (autoFix?.isBusy) return;

      // Still inside the initial grace window since this chat's first
      // message -- a brand-new sandbox hasn't had a fair chance to exist
      // yet, let alone boot.
      if (firstSeenAtRef.current !== null && Date.now() - firstSeenAtRef.current < INITIAL_GRACE_MS) return;

      unavailableStreakRef.current += 1;
      if (unavailableStreakRef.current < STUCK_THRESHOLD) return;

      // Direct/BYOK chats have a real reachable sandbox -- one silent
      // restart, never touching the chat/conversation. Nothing more than
      // this ever happens automatically now.
      if (data.isDirect && !selfHealAttemptedRef.current) {
        selfHealAttemptedRef.current = true;
        await restart();
        unavailableStreakRef.current = 0; // give the restart a fresh window to actually land
      }
    } catch {
      // Transient network error -- next poll tick retries.
    }
  }, [sessionId, hasMessages, restart, autoFix]);

  useEffect(() => {
    if (!sessionId || !hasMessages) return;
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId, hasMessages, poll]);

  return { state, autoFixing: false, manualRestart: restart, refresh: poll };
}
