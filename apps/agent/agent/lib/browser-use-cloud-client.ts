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
 * Two API keys (BROWSER_USE_API_KEY / BROWSER_USE_API_KEY_2) are
 * configured on purpose -- explicit user request: "use both at the same
 * time so it can work in parallel". Each is a fully independent
 * account/quota, so keying every request off an explicit `slot` (1 or 2)
 * is what actually gets two simultaneous live browsers instead of both
 * competing for one account's concurrency limit. Callers (tool-impls)
 * decide which slot a given browser session uses and persist that
 * choice in ChatBrowserSession.slot so follow-ups/stops hit the same
 * key the session was created under.
 *
 * No SDK dependency added -- the REST surface used here (create/dispatch,
 * get, stop) is tiny and stable (see docs.browser-use.com/cloud/api-reference),
 * and avoiding the SDK keeps this in line with every other tool-impl in
 * this directory (bash.ts, web_search.ts, etc.), which all call their
 * provider's plain HTTP API directly rather than pulling in a dedicated
 * client library for one or two endpoints.
 */

const BASE_URL = 'https://api.browser-use.com/api/v3';

export type BrowserUseSlot = 1 | 2;

export interface BrowserUseSessionResult {
  id: string;
  liveUrl: string | null;
  output: unknown;
  /** null/undefined while the task is still running -- see getBrowserUseSession's file comment. */
  isTaskSuccessful: boolean | null;
  stepCount: number;
  lastStepSummary: string | null;
  screenshotUrl: string | null;
}

function apiKeyForSlot(slot: BrowserUseSlot): string {
  const key = slot === 1 ? process.env.BROWSER_USE_API_KEY : process.env.BROWSER_USE_API_KEY_2;
  if (!key) {
    throw new Error(`BROWSER_USE_API_KEY${slot === 2 ? '_2' : ''} is not set -- cannot use browser slot ${slot}.`);
  }
  return key;
}

async function call(slot: BrowserUseSlot, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'X-Browser-Use-API-Key': apiKeyForSlot(slot),
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    // leave json null -- fall through to the raw text in the error below
  }
  if (!res.ok) {
    const detail = json && 'detail' in json ? JSON.stringify(json.detail) : text.slice(0, 500);
    throw new Error(`Browser Use API ${res.status}: ${detail || 'unknown error'}`);
  }
  return json ?? {};
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
  };
}

/**
 * Creates a brand new session + dispatches a task (when `sessionId` is
 * omitted), or dispatches a follow-up task to an already-idle session
 * (when `sessionId` is the PROVIDER's session id, not ours) -- same
 * `/sessions` endpoint handles both per Browser Use's own API reference.
 * `keepAlive: true` is what lets a session accept a follow-up at all
 * instead of auto-stopping the moment its first task finishes.
 */
export async function createOrDispatchBrowserUseTask(
  slot: BrowserUseSlot,
  opts: { task: string; sessionId?: string; keepAlive?: boolean },
): Promise<BrowserUseSessionResult> {
  const json = await call(slot, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      task: opts.task,
      sessionId: opts.sessionId,
      keepAlive: opts.keepAlive ?? true,
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

/** Stops a running/idle session outright -- ends the live browser for good. */
export async function stopBrowserUseSession(slot: BrowserUseSlot, providerSessionId: string): Promise<void> {
  await call(slot, `/sessions/${encodeURIComponent(providerSessionId)}/stop`, { method: 'POST' });
}
