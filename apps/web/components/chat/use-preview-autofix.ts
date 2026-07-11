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
// ~12s of consecutive unavailable polls before treating this as a real,
// stuck problem -- a sandbox normally takes a few seconds to boot, and
// that's completely normal, not something worth escalating.
const STUCK_THRESHOLD = 3;
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
  const sendAutoFix = useAutoFixSend();

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
    if (!sessionId) return;
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
      if (sendAutoFix && errorKey && (!alreadyEscalatedThisError || cooldownElapsed)) {
        lastEscalatedKeyRef.current = errorKey;
        lastEscalatedAtRef.current = now;
        setAutoFixing(true);
        sendAutoFix(
          `The app preview isn't connecting (status: ${data.status}). ${
            data.error || data.reason || 'No further detail was reported.'
          } Please check the dev server/sandbox and fix it (restart it if needed) so the preview connects.`
        );
      }
    } catch {
      // Transient network error -- next poll tick retries, nothing to
      // escalate over a single missed check.
    }
  }, [sessionId, restart, sendAutoFix]);

  useEffect(() => {
    if (!sessionId) return;
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId, poll]);

  return { state, autoFixing, manualRestart: restart, refresh: poll };
}
