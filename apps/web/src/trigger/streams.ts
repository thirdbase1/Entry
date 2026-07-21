/**
 * Realtime chunk stream definitions for the durable background worker
 * (2026-07-21).
 *
 * agent-turn.ts (running inside a Trigger.dev task, detached from any
 * HTTP connection) builds the exact same `toUIMessageStream()` protocol
 * the synchronous /api/direct/chat route already streams to the browser
 * over SSE. Piping that same chunk stream through this defined realtime
 * stream lets a frontend subscriber (useRealtimeStream, via a scoped
 * public access token minted per-run by
 * /api/chats/[sessionId]/realtime-token) render live text and tool-call
 * cards for a background-handed-off turn exactly like a normal
 * synchronous turn -- instead of only ever seeing whatever the 3s DB
 * poll (direct-chat-interface.tsx) last caught.
 *
 * NOTE: `metadata.stream()` (the older API this replaces) is deprecated
 * as of @trigger.dev/sdk 4.x in favor of `streams.define()` +
 * `useRealtimeStream` -- see streams.d.ts's `@deprecated` tag on
 * `metadata.stream`. Unlimited stream length/active-streams and 28-day
 * retention also make this a strict upgrade for a worker that can chain
 * up to 6 hours across auto-continue hops.
 */
import { streams, type InferStreamType } from '@trigger.dev/sdk/v3';
import type { UIMessageChunk } from 'ai';

export const chatUiStream = streams.define<UIMessageChunk>({ id: 'chat-ui' });
export type ChatUiStreamPart = InferStreamType<typeof chatUiStream>;
