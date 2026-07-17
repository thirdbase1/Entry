/**
 * Thin client for Browser Use Cloud (browser-use.com) v3 REST API.
 *
 * ADDED (2026-07-16, explicit user request: "agent uses a real cloud
 * browser, not a Vercel/sandbox one; I want to see it live"). Replaces
 * the old approach in tool-impls/browser_use.ts (agent-browser CLI
 * driven step-by-step inside the E2B sandbox, screenshots uploaded
 * after each action) -- that never had a real-time view, only stale
 * post-hoc images. Browser Use Cloud's `liveUrl` is a genuine embeddable
 * live view of the actual running browser (see
 * docs.browser-use.com/cloud/browser/live-preview), which is the whole
 * point of this switch.
 *
 * REMOVED (2026-07-17, explicit user request: "remove that browser slot
 * 2... I remember we only have two browsers"): this used to support a
 * second Browser Use Cloud key (BROWSER_USE_API_KEY_2) as an extra
 * parallel lane. That second key was never actually provisioned in
 * production (confirmed live: process.env.BROWSER_USE_API_KEY_2 is
 * simply absent there), so the "3-lane" model was really only ever a
 * 2-lane one in practice (Browser Use slot 1 + Steel) -- the type below
 * is now a plain `1` rather than `1 | 2` to match reality instead of
 * silently offering a slot that can never work.
 *
 * No SDK dependency added -- the REST surface used here (create/dispatch,
 * get, stop, list messages) is small and stable (confirmed field-by-field
 * against Browser Use's published OpenAPI v3 spec at
 * docs.browser-use.com/cloud/openapi/v3.json on 2026-07-16/17 before
 * shipping with real keys -- every field name here, including the
 * request body's camelCase task/sessionId/keepAlive, matches that spec
 * exactly), and avoiding the SDK keeps this in line with every other
 * tool-impl in this directory (bash.ts, web_search.ts, etc.), which all
 * call their provider's plain HTTP API directly rather than pulling in a
 * dedicated client library for a handful of endpoints.
 *
 * UPDATED (2026-07-17, "make the whole browser feature 3x better"):
 * added retry-with-backoff for transient failures (network hiccups,
 * 429/5xx) since a single flaky poll used to surface as a hard tool
 * error instead of just quietly succeeding on the next attempt; added
 * `enableRecording` passthrough + `recordingUrls` on the response so a
 * finished session can offer a "watch recording" link; added
 * `listSessionMessages` so callers can stream the agent's own live
 * reasoning/step messages (role/summary) alongside the video, not just
 * a final output at the very end.
 */

const BASE_URL = 'https://api.browser-use.com/api/v3';

export type BrowserUseSlot = 1;

export interface BrowserUseSessionResult {
  id: string;
  liveUrl: string | null;
  output: unknown;
  /** null/undefined while the task is still running -- see getBrowserUseSession's file comment. */
  isTaskSuccessful: boolean | null;
  stepCount: number;
  lastStepSummary: string | null;
  screenshotUrl: string | null;
  /** Presigned MP4 URL(s), only populated once recording is ready -- empty while running or if recording wasn't enabled. */
  recordingUrls: string[];
}

export interface BrowserUseMessage {
  id: string;
  role: string;
  type: string;
  summary: string;
  screenshotUrl: string | null;
}

function apiKeyForSlot(_slot: BrowserUseSlot): string {
  const key = process.env.BROWSER_USE_API_KEY;
  if (!key) {
    throw new Error('BROWSER_USE_API_KEY is not set -- cannot use the Browser Use Cloud lane.');
  }
  return key;
}

// Transient failures (network blips, provider-side 429/5xx) shouldn't
// surface as a hard tool error on the first hiccup -- retried a couple
// times with a short, fixed backoff before actually giving up. 4xx other
// than 429 are real client errors (bad request, not-found, etc.) and are
// never worth retrying.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

async function call(slot: BrowserUseSlot, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          'X-Browser-Use-API-Key': apiKeyForSlot(slot),
          'Content-Type': 'application/json',
          ...(init?.headers || {}),
        },
      });
    } catch (err) {
      // Network-level failure (DNS, timeout, connection reset) -- always worth a retry.
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      // leave json null -- fall through to the raw text in the error below
    }
    if (!res.ok) {
      const detail = json && 'detail' in json ? JSON.stringify(json.detail) : text.slice(0, 500);
      lastErr = new Error(`Browser Use API ${res.status}: ${detail || 'unknown error'}`);
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw lastErr;
    }
    return json ?? {};
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function normalize(json: Record<string, unknown>): BrowserUseSessionResult {
  return {
    id: String(json.id ?? ''),
    liveUrl: typeof json.liveUrl === 'string' ? json.liveUrl : null,
    output: json.output ?? null,
    isTaskSuccessful: typeof json.isTaskSuccessful === 'boolean' ? json.isTaskSuccessful : null,
    stepCount: typeof json.stepCount === 'number' ? json.stepCount : 0,
    lastStepSummary: typeof json.lastStepSummary === 'string' ? json.lastStepSummary : null,
    screenshotUrl: typeof json.screenshotUrl === 'string' ? json.screenshotUrl : null,
    recordingUrls: Array.isArray(json.recordingUrls) ? json.recordingUrls.filter((u): u is string => typeof u === 'string') : [],
  };
}

/**
 * Creates a brand new session + dispatches a task (when `sessionId` is
 * omitted), or dispatches a follow-up task to an already-idle session
 * (when `sessionId` is the PROVIDER's session id, not ours) -- same
 * `/sessions` endpoint handles both per Browser Use's own API reference.
 * `keepAlive: true` is what lets a session accept a follow-up at all
 * instead of auto-stopping the moment its first task finishes.
 * `enableRecording: true` by default -- cheap (no extra cost beyond the
 * session itself) and gives the UI a "watch recording" link once the
 * session ends, no reason for the user to have to ask for it.
 */
export async function createOrDispatchBrowserUseTask(
  slot: BrowserUseSlot,
  opts: { task: string; sessionId?: string; keepAlive?: boolean; enableRecording?: boolean },
): Promise<BrowserUseSessionResult> {
  const json = await call(slot, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      task: opts.task,
      sessionId: opts.sessionId,
      keepAlive: opts.keepAlive ?? true,
      enableRecording: opts.enableRecording ?? true,
    }),
  });
  return normalize(json);
}

/**
 * Polls the current state of a session/task. `isTaskSuccessful` is the
 * completion signal used throughout this integration: null/undefined
 * while the agent is still working, a real boolean once it's done.
 * (Confirmed against Browser Use's documented Session resource shape --
 * if a future API version adds an explicit `status` enum, prefer that
 * instead and update this + browser_use.ts's poll loop together.)
 */
export async function getBrowserUseSession(slot: BrowserUseSlot, providerSessionId: string): Promise<BrowserUseSessionResult> {
  const json = await call(slot, `/sessions/${encodeURIComponent(providerSessionId)}`);
  return normalize(json);
}

/**
 * Stops a session. `strategy: 'session'` (default) destroys the sandbox
 * entirely -- ends the live browser for good. `strategy: 'task'` only
 * cancels the currently-running task and leaves the session alive/idle,
 * ready for a follow-up -- useful when a task is stuck/wrong-headed but
 * the user still wants to keep the same logged-in browser around.
 */
export async function stopBrowserUseSession(slot: BrowserUseSlot, providerSessionId: string, strategy: 'session' | 'task' = 'session'): Promise<void> {
  await call(slot, `/sessions/${encodeURIComponent(providerSessionId)}/stop`, { method: 'POST', body: JSON.stringify({ strategy }) });
}

/**
 * Lists the agent's own step-by-step messages (reasoning, tool calls,
 * browser actions) for a session, newest since `after` (cursor = last
 * message id already seen). This is what turns the Browser tab from
 * "just a video" into an actual live thought-stream next to it -- see
 * docs.browser-use.com/cloud/agent/streaming.
 */
export async function listBrowserUseMessages(slot: BrowserUseSlot, providerSessionId: string, after?: string): Promise<BrowserUseMessage[]> {
  const qs = new URLSearchParams({ limit: '100' });
  if (after) qs.set('after', after);
  const json = await call(slot, `/sessions/${encodeURIComponent(providerSessionId)}/messages?${qs.toString()}`);
  const messages = Array.isArray(json.messages) ? json.messages : [];
  return messages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.hidden !== true)
    .map(m => ({
      id: String(m.id ?? ''),
      role: typeof m.role === 'string' ? m.role : 'ai',
      type: typeof m.type === 'string' ? m.type : 'message',
      summary: typeof m.summary === 'string' && m.summary ? m.summary : (typeof m.data === 'string' ? m.data.slice(0, 200) : ''),
      screenshotUrl: typeof m.screenshotUrl === 'string' ? m.screenshotUrl : null,
    }))
    .filter(m => m.summary);
}
