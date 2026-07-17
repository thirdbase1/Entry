import { chromium, type Browser } from 'playwright-core';

/**
 * ADDED (2026-07-16) -- third parallel browser lane, explicit user
 * request: "I dropped two keys... use both, or use both at the same
 * time so it can work in parallel." Steel (steel.dev) is a genuinely
 * different provider from Browser Use Cloud: it hands back a RAW remote
 * Chrome (via CDP over websocket) plus a live viewer URL
 * (sessionViewerUrl) -- there's no built-in agent that plans/executes a
 * task for you like Browser Use has. browser_use.ts's steel branch
 * drives it itself via Playwright's connectOverCDP + a small decide/act
 * loop (see that file), reusing the exact same "one real action per
 * step, screenshot after each" shape the tool already returns to the UI.
 *
 * No `steel-sdk` dependency added -- same reasoning as
 * browser-use-cloud-client.ts: the REST surface actually needed here
 * (create, release) is two calls, so a plain fetch avoids pulling in a
 * whole SDK for that. `playwright-core` (already added as a dependency)
 * IS needed since driving the actual remote browser requires a real CDP
 * client, not just HTTP.
 *
 * UPDATED (2026-07-16, live keys provisioned -- verified directly against
 * Steel's current docs before shipping): the live-embed field is
 * `debugUrl`, not `sessionViewerUrl`. Steel's docs are explicit that
 * `debugUrl` is the new WebRTC-based headful live view ("low-latency,
 * high-fidelity... 25fps") -- exactly the "no latency issues" the user
 * asked for -- while `sessionViewerUrl` (still returned, still a valid
 * field on the Session object, kept here only as a fallback) is the
 * older viewer this replaced. `?interactive=false` is appended so the
 * embed is watch-only -- the agent drives it, not whoever's looking at
 * the chat.
 */

const BASE_URL = 'https://api.steel.dev/v1';

function apiKey(): string {
  const key = process.env.STEEL_API_KEY;
  if (!key) throw new Error('STEEL_API_KEY is not set -- cannot use the Steel browser lane.');
  return key;
}

export interface SteelSession {
  id: string;
  /** The low-latency WebRTC live-embed URL (Steel's `debugUrl`, falling back to `sessionViewerUrl`), `?interactive=false` already appended. */
  liveUrl: string | null;
  websocketUrl: string;
}

export async function createSteelSession(): Promise<SteelSession> {
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'Steel-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    // Generous timeout + release-on-idle so a chat that goes quiet for a
    // while doesn't leave a Steel session (and its per-minute billing)
    // running forever -- matches keepAlive's spirit on the Browser Use
    // lane without a literal keepAlive flag (Steel's model is simpler:
    // the session just lives until timeout/inactivityTimeout/release).
    body: JSON.stringify({ timeout: 1_800_000, inactivityTimeout: 900_000 }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // leave json empty -- error path below still surfaces raw text
  }
  if (!res.ok) {
    throw new Error(`Steel API ${res.status}: ${JSON.stringify(json).slice(0, 500) || text.slice(0, 500)}`);
  }
  const websocketUrl = String(json.websocketUrl ?? '');
  if (!websocketUrl) throw new Error('Steel session response was missing websocketUrl.');
  const rawLiveUrl =
    (typeof json.debugUrl === 'string' && json.debugUrl) ||
    (typeof json.sessionViewerUrl === 'string' && json.sessionViewerUrl) ||
    null;
  return {
    id: String(json.id ?? ''),
    liveUrl: rawLiveUrl ? `${rawLiveUrl}${rawLiveUrl.includes('?') ? '&' : '?'}interactive=false` : null,
    websocketUrl,
  };
}

/** Reattaches to an already-created (still-alive) Steel session's live browser. */
export async function connectSteelBrowser(websocketUrl: string): Promise<Browser> {
  return chromium.connectOverCDP(`${websocketUrl}&apiKey=${encodeURIComponent(apiKey())}`);
}

export async function stopSteelSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/release`, {
    method: 'POST',
    headers: { 'Steel-Api-Key': apiKey() },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Steel release API ${res.status}: ${text.slice(0, 500)}`);
  }
}
