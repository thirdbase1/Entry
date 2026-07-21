'use client';

/**
 * Live preview for a chat turn that's been handed off to the durable
 * background worker (2026-07-21) -- the frontend half of
 * apps/web/src/trigger/streams.ts + agent-turn.ts's realtime chunk
 * piping + /api/chats/[sessionId]/realtime-token.
 *
 * Subscribes to whichever Trigger.dev run is currently the chat's active
 * background worker and reconstructs a live-updating UIMessage from its
 * chunk stream -- the exact same toUIMessageStream() protocol the
 * synchronous /api/direct/chat route streams over SSE for a normal turn.
 * direct-chat-interface.tsx appends the result as a synthetic extra
 * message purely for display while `active` is true, so a handed-off
 * turn renders with the same live text + tool-call cards a normal turn
 * gets, instead of only ever refreshing on the 3s DB poll.
 *
 * Token lifecycle: /api/chats/[sessionId]/realtime-token mints a public
 * access token scoped to just that one run, expiring after 20 minutes
 * (see that route's comment for why a dedicated endpoint) -- refetched
 * every 8 minutes here so a long chained background run (up to 6h across
 * MAX_HOPS auto-continue hops) never loses its live preview mid-way, and
 * re-picks up the NEW run ID automatically each time a fresh hop starts
 * (agent-turn.ts re-sets backgroundRunId at the top of every run).
 *
 * Failure anywhere in this hook is silently non-fatal by design -- the
 * 3s DB poll in direct-chat-interface.tsx is the actual source of truth
 * and recovery path; this is a best-effort smoothness layer on top.
 */
import { useEffect, useState } from 'react';
import { useRealtimeStream } from '@trigger.dev/react-hooks';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';

// Deliberately NOT importing chatUiStream from '@/src/trigger/streams' here --
// that pulls in @trigger.dev/sdk's server-only auth/skills modules (node:fs,
// node:path, node:async_hooks) which webpack can't bundle client-side.
// The plain-string-key overload of useRealtimeStream avoids that entirely;
// 'chat-ui' must stay in sync with the id passed to streams.define() in
// src/trigger/streams.ts.

export function useBackgroundChunkStreamPreview(sessionId: string | null, active: boolean): UIMessage | undefined {
  const [runId, setRunId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !sessionId) {
      setRunId(null);
      setAccessToken(null);
      return;
    }
    let cancelled = false;
    const fetchToken = async () => {
      try {
        const res = await fetch(`/api/chats/${sessionId}/realtime-token`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setRunId(data?.runId ?? null);
        setAccessToken(data?.accessToken ?? null);
      } catch {
        // Non-fatal -- DB polling remains the real recovery path.
      }
    };
    fetchToken();
    const id = window.setInterval(fetchToken, 8 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId, active]);

  const { parts } = useRealtimeStream<UIMessageChunk>(runId ?? '', 'chat-ui', {
    accessToken: accessToken ?? undefined,
    enabled: !!(runId && accessToken),
    // Generous idle timeout -- a long tool call (bash/browser/sub-agent)
    // can legitimately produce no new UI chunks for several minutes
    // while still being a perfectly healthy turn.
    timeoutInSeconds: 1200,
  });

  const [liveMessage, setLiveMessage] = useState<UIMessage | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      setLiveMessage(undefined);
      return;
    }
    if (!parts || parts.length === 0) return;
    let cancelled = false;
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const p of parts) controller.enqueue(p as unknown as UIMessageChunk);
        controller.close();
      },
    });
    (async () => {
      let last: UIMessage | undefined;
      for await (const msg of readUIMessageStream({ stream })) {
        last = msg;
      }
      if (!cancelled && last) setLiveMessage(last);
    })();
    return () => {
      cancelled = true;
    };
  }, [parts, active]);

  return active ? liveMessage : undefined;
}
