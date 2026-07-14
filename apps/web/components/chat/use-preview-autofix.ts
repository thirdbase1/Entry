'use client';

/**
 * Shared preview status polling + auto-fix escalation (2026-07-11,
 * explicit user request: "the preview is having issues, it should always
 * connect... if the preview have issues connecting it should send it
 * automatically to the AI to fix, showing the error -- not when I click
 * preview should it be stating [the error]").
 *
 * Two real changes from the old click-to-discover behavior:
 *
 * 1. This now lives in ChatPageHeader (always mounted while the chat page
 *    is open), NOT inside ChatPreviewPanel (only mounted while the panel
 *    is actually open) -- so a broken preview gets noticed and acted on
 *    whether or not the user ever opens the panel at all, instead of only
 *    the moment they happen to click "Preview".
 * 2. A real, sustained failure (not just the normal few-second boot gap)
 *    now automatically does one of two things instead of just displaying
 *    static text:
 *      - direct/BYOK chats (a real reachable sandbox): try one silent
 *        self-restart first, no agent/chat message involved at all.
 *      - eve-path chats, or a direct chat whose self-restart didn't fix
 *        it: inject one real chat message describing the exact error
 *        into the live conversation via useAutoFixSend, so the agent
 *        actually sees it and can use its own restart_sandbox/
 *        get_preview_url tools -- same as if the user had typed it in,
 *        just automatic.
 *
 * FIXED (2026-07-15, real confirmed bug reported as three symptoms that
 * turned out to be the same root cause -- "sandbox always fails to
 * start", "why is the sandbox even trying to start for a new chat that's
 * empty", "why if AI do tool calling it stop instantly"): this hook used
 * to start polling the instant the page mounted and treat 3 consecutive
 * misses (~12s) as "stuck" regardless of anything else going on. On a
 * brand-new chat, the very first turn frequently does real setup work
 * (bash/create_skill, npm installs, scaffolding an actual project) for
 * well over 12 seconds before any dev server exists AT ALL to preview --
 * there was never a sandbox to be "stuck," it just hadn't been created
 * yet. Because escalation calls the exact same send path a real user turn
 * uses (see chat-auto-fix-context.tsx), firing it while that first turn's
 * own tool calls were still actively streaming aborted them outright --
 * "the AI stops tool calling instantly" was this hook interrupting its
 * own agent moments after the turn started, every time, on every fresh
 * chat, because nothing was actually wrong yet.
 *
 * Three real fixes, not just a bigger number:
 *   1. Never poll/escalate at all for a chat with zero messages -- there
 *      is nothing to preview yet, full stop (read from AutoFixSendContext).
 *   2. Never escalate while a turn is actively streaming (`isBusy` from
 *      AutoFixSendContext) -- a live tool call is expected downtime, not
 *      a stuck sandbox, and calling `send` right now would abort it.
 *   3. Give a real grace period after the chat's first-ever turn starts
 *      before the "stuck" streak counter starts counting at all -- a
 *      brand-new sandbox routinely takes well over 12s for its first real
 *      boot (dependency install, initial build), which isn't a failure.
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
// ~24s of consecutive unavailable polls before treating this as a real,
// stuck problem -- doubled from the original 12s (2026-07-15): a sandbox
// can legitimately take a while to boot the FIRST time (dependency
// install, initial build), and 12s was routinely shorter than that,
// which is what caused false "stuck" escalations on brand-new chats.
const STUCK_THRESHOLD = 6;
// Grace period after the chat's first-ever turn starts before the stuck
// counter is even allowed to run -- a fresh sandbox/dev-server on a
// brand-new chat needs real time to exist at all, let alone boot.
const INITIAL_GRACE_MS = 45 * 1000;
// Don't re-nag the agent about the exact same failure more than once
// every few minutes, even if it keeps recurring turn after turn.
const RE_ESCALATE_COOLDOWN_MS = 5 * 60 * 1000;

export function usePreviewAutoFix(sessionId: string | undefined) {
  const [state, setState] = useState<PreviewStatus | null>(null);
  const [autoFixing, setAutoFixing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unavailableStreakRef = useRef(0);
  const selfHealAttemptedRef = useRef(false);
  const lastEscalatedKeyRef = useRef<string | null>(null);
  const lastEscalatedAtRef = useRef(0);
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
        setAutoFixing(false);
        return;
      }

      // A turn is actively streaming right now -- a tool call legitimately
      // rebuilding/restarting the dev server is expected downtime, not a
      // stuck sandbox. Don't count it toward the streak, and never send
      // anything while a turn is in flight (would abort it outright).
      if (autoFix?.isBusy) return;

      // Still inside the initial grace window since this chat's first
      // message -- a brand-new sandbox hasn't had a fair chance to exist
      // yet, let alone boot.
      if (firstSeenAtRef.current !== null && Date.now() - firstSeenAtRef.current < INITIAL_GRACE_MS) return;

      unavailableStreakRef.current += 1;
      if (unavailableStreakRef.current < STUCK_THRESHOLD) return;

      const errorKey = data.error || data.reason || data.status;

      // Direct/BYOK chats have a real reachable sandbox -- try one silent
      // restart before ever bothering the agent about it.
      if (data.isDirect && !data.requiresAgentAction && !selfHealAttemptedRef.current) {
        selfHealAttemptedRef.current = true;
        await restart();
        unavailableStreakRef.current = 0; // give the restart a fresh window to actually land
        return;
      }

      const now = Date.now();
      const alreadyEscalatedThisError = lastEscalatedKeyRef.current === errorKey;
      const cooldownElapsed = now - lastEscalatedAtRef.current > RE_ESCALATE_COOLDOWN_MS;
      if (autoFix?.send && errorKey && (!alreadyEscalatedThisError || cooldownElapsed)) {
        lastEscalatedKeyRef.current = errorKey;
        lastEscalatedAtRef.current = now;
        setAutoFixing(true);
        autoFix.send(
          `The app preview isn't connecting (status: ${data.status}). ${
            data.error || data.reason || 'No further detail was reported.'
          } Please check the dev server/sandbox and fix it (restart it if needed) so the preview connects.`
        );
      }
    } catch {
      // Transient network error -- next poll tick retries, nothing to
      // escalate over a single missed check.
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

  return { state, autoFixing, manualRestart: restart, refresh: poll };
}
