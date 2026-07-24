/**
 * ADDED (2026-07-25) -- fourth/fifth parallel browser lane, explicit user
 * request: "Integrate anchor browser" (docs.anchorbrowser.io).
 *
 * Anchor Browser is architecturally closest to Browser Use Cloud among
 * the existing lanes -- it's fully agentic: give `performAnchorWebTask` a
 * natural-language prompt and Anchor's own agent (default `browser-use`,
 * configurable) plans and executes the whole thing server-side, in ONE
 * synchronous HTTP call that returns the final result directly (verified
 * live: a trivial task completed in ~4-7s with no polling needed). Unlike
 * Bright Data, Anchor DOES support real session continuation:
 *   1. `createAnchorSession` (POST /v1/sessions) allocates a real browser
 *      and hands back BOTH a `cdp_url` (raw CDP, unused here but kept on
 *      the type in case a future lane wants to drive it directly) and a
 *      `live_view_url` -- a genuine embeddable live view, available
 *      immediately, no CDP round-trip needed (unlike Bright Data's
 *      `getLiveInspectUrl`).
 *   2. `performAnchorWebTask` is called with that session's id (as the
 *      `sessionId` query param) plus a `url` on the FIRST call only --
 *      omit `url` on follow-ups and the agent continues on whatever page
 *      the previous call left it on (verified live: a follow-up prompt
 *      with no `url` correctly saw the page navigated to by the prior
 *      call).
 *   3. `endAnchorSession` (DELETE /v1/sessions/{id}) tears it down --
 *      called from browser_stop.ts, mirroring Steel's `stopSteelSession`.
 *
 * No SDK dependency -- same reasoning as steel-client.ts: the REST
 * surface actually needed (create session, run task, end session) is
 * three plain fetch calls.
 */

const BASE_URL = 'https://api.anchorbrowser.io/v1';

function apiKey(): string {
  const key = process.env.ANCHORBROWSER_API_KEY;
  if (!key) throw new Error('ANCHORBROWSER_API_KEY is not set -- cannot use the Anchor Browser lane.');
  return key;
}

async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // leave json empty -- error path below still surfaces raw text
  }
  if (!res.ok) {
    const message = (json.error as { message?: string } | undefined)?.message;
    throw new Error(`Anchor Browser API ${res.status}: ${message ?? (JSON.stringify(json).slice(0, 500) || text.slice(0, 500))}`);
  }
  return json;
}

export interface AnchorSession {
  id: string;
  /** Real embeddable live view -- available immediately, no extra round-trip needed. */
  liveViewUrl: string | null;
  /** Raw CDP websocket URL -- unused for now, kept for a possible future raw-driven lane. */
  cdpUrl: string | null;
}

export async function createAnchorSession(): Promise<AnchorSession> {
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'anchor-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const json = await parseJsonResponse(res);
  const data = (json.data ?? {}) as { id?: string; cdp_url?: string; live_view_url?: string };
  if (!data.id) throw new Error('Anchor Browser session response was missing an id.');
  return { id: data.id, liveViewUrl: data.live_view_url ?? null, cdpUrl: data.cdp_url ?? null };
}

export interface AnchorWebTaskResult {
  output: string | null;
  isTaskSuccessful: boolean;
  steps: number | null;
}

/** Runs one agentic task in an Anchor Browser session. Pass `url` only on the first call for a session -- omit it on follow-ups to continue on whatever page the previous task left the browser on. */
export async function performAnchorWebTask(params: { prompt: string; sessionId: string; url?: string }): Promise<AnchorWebTaskResult> {
  const qs = new URLSearchParams({ sessionId: params.sessionId });
  const res = await fetch(`${BASE_URL}/tools/perform-web-task?${qs.toString()}`, {
    method: 'POST',
    headers: { 'anchor-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(params.url ? { prompt: params.prompt, url: params.url } : { prompt: params.prompt }),
  });
  const json = await parseJsonResponse(res);
  const status = typeof json.status === 'string' ? json.status : null;
  return {
    output: typeof json.result === 'string' ? json.result : null,
    isTaskSuccessful: status ? status === 'success' : true,
    steps: typeof json.steps === 'number' ? json.steps : null,
  };
}

export async function endAnchorSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { 'anchor-api-key': apiKey() },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anchor Browser end-session API ${res.status}: ${text.slice(0, 500)}`);
  }
}
