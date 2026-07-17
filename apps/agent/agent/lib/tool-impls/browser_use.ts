import { z } from 'zod';
import { generateObject, generateText, NoObjectGeneratedError } from 'ai';
import { prisma } from '@entry/db';
import { put } from '@vercel/blob';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import {
  createOrDispatchBrowserUseTask,
  getBrowserUseSession,
  listBrowserUseMessages,
  type BrowserUseSlot,
  type BrowserUseSessionResult,
} from '../browser-use-cloud-client.js';
import { createSteelSession, connectSteelBrowser } from '../steel-client.js';
import { connectBrightDataBrowser, getLiveInspectUrl } from '../brightdata-client.js';

/**
 * REWRITTEN (2026-07-16, explicit user request: "agent uses a real cloud
 * browser, not that Vercel/sandbox use browser -- and the UI should
 * actually display the live browser and I'm seeing what it's doing
 * realtime. Browser should stay active. Agent should be able to stop and
 * start it. Use both [providers], or use both at the same time so it can
 * work in parallel."). Replaced the old approach (agent-browser CLI
 * driven step-by-step inside this chat's own sandbox, screenshots
 * uploaded after each action -- never a real-time view, only stale
 * after-the-fact images) with two REAL cloud browser providers, each a
 * genuinely independent lane so tasks can run in parallel:
 *
 *   - Browser Use Cloud (browser-use.com): fully agentic -- give it a
 *     task, its OWN agent plans and executes the whole thing server-side.
 *     Two lanes (slot 1/2, one per BROWSER_USE_API_KEY[_2]).
 *   - Steel (steel.dev): a raw remote Chrome over CDP -- WE drive it, via
 *     the decide/act loop below (Playwright + a cheap deciding model),
 *     same one-real-action-per-step shape the old sandbox implementation
 *     used. One lane (slot 1, STEEL_API_KEY).
 *
 * Both expose a genuine embeddable live view (Browser Use's `liveUrl`,
 * Steel's `debugUrl`, see steel-client.ts) -- persisted to ChatBrowserSession the
 * moment a session is created, which is what lets the Browser tab in the
 * chat UI show the live iframe independent of this tool call's own
 * lifetime. Steel's `websocketUrl` (needed to reattach to the same live
 * browser on a follow-up call) is stashed in `metadata` since it's not
 * something the UI or Browser Use's lane needs at all.
 *
 * pickFreeLane always tries Browser Use before Steel, since Browser Use
 * needs zero extra code here (its own agent does the work) while Steel
 * costs an LLM call per step -- both genuinely run in parallel across
 * different chat turns/tasks since each is tracked as its own
 * ChatBrowserSession row.
 *
 * REMOVED (2026-07-17, explicit user request: "remove that browser slot
 * 2... I remember we only have two browsers"): the second Browser Use
 * Cloud slot never actually had a key provisioned in production, so it
 * was a lane that could never really work -- down to the two lanes that
 * are actually real: one Browser Use Cloud key, one Steel key. Also
 * fixed the real cause of "Steel doesn't work" (see steel-client.ts):
 * Steel was being asked for a 30-minute session timeout, which the
 * account's actual plan caps at 15 -- every session create was failing
 * outright on a 400 before it ever got anywhere near the UI.
 *
 * UPDATED (2026-07-17, "make the whole browser feature 3x better"):
 *   - Both lanes now persist a live, incrementally-growing `steps` feed
 *     to the DB DURING execution (not just once at the very end), so the
 *     chat UI's Browser tab can show a real thought-stream next to the
 *     video instead of the video being the only signal something's
 *     happening. Browser Use's steps come from its own message stream
 *     (docs.browser-use.com/cloud/agent/streaming); Steel's come from
 *     this file's own decide/act loop, one entry per action.
 *   - Browser Use sessions now request `enableRecording`, and once a
 *     recording is ready its presigned URL is persisted to
 *     `recordingUrl` so the UI can offer "watch recording" after a
 *     session ends.
 *   - Poll cadence tightened (3000ms -> 2000ms) for a snappier feed.
 *   - Steel's step budget raised (12 -> 20 steps) so more involved
 *     multi-step tasks (multi-page flows, forms with several fields)
 *     have a realistic chance of finishing in one call instead of
 *     hitting the ceiling early.
 */

const POLL_INTERVAL_MS = 2000;
// How long THIS tool call keeps polling/stepping before reporting back --
// NOT the browser's own lifetime. Both providers keep the session alive
// well past this on their own (Browser Use's keepAlive, Steel's
// timeout/inactivityTimeout), so a long task doesn't get killed just
// because this loop gave up watching -- exactly "the browser should
// still be active" from the request. Call back in with session_id to
// keep going.
const WALL_CLOCK_BUDGET_MS = 60_000;
const MAX_STEEL_STEPS = 20;
const MAX_STEPS_STORED = 200;

type Lane = { provider: 'browser_use'; slot: BrowserUseSlot } | { provider: 'steel'; slot: 1 } | { provider: 'brightdata'; slot: 1 };

const LANES: Lane[] = [
  { provider: 'browser_use', slot: 1 },
  { provider: 'steel', slot: 1 },
  { provider: 'brightdata', slot: 1 },
];

type SessionRow = {
  id: string;
  chatId: string;
  provider: string;
  slot: number;
  providerSessionId: string;
  metadata: unknown;
  liveUrl: string | null;
  output: string | null;
  isTaskSuccessful: boolean | null;
  steps: unknown;
  recordingUrl: string | null;
};

type StepEntry = { id?: string; role: string; summary: string; screenshotUrl: string | null; at: string };

function appendSteps(existing: unknown, add: StepEntry[]): StepEntry[] {
  if (add.length === 0) return Array.isArray(existing) ? (existing as StepEntry[]) : [];
  const cur = Array.isArray(existing) ? (existing as StepEntry[]) : [];
  const merged = [...cur, ...add];
  return merged.length > MAX_STEPS_STORED ? merged.slice(merged.length - MAX_STEPS_STORED) : merged;
}

async function pickFreeLane(chatId: string, preferred?: 'browser_use' | 'steel' | 'brightdata'): Promise<Lane> {
  const active = await prisma.chatBrowserSession.findMany({
    where: { chatId, status: { in: ['running', 'idle'] } },
    select: { provider: true, slot: true },
  });
  const used = new Set(active.map(a => `${a.provider}:${a.slot}`));
  // If the caller asked for a specific provider, honor it (try it first) --
  // this is what actually lets the agent "just call Steel" instead of the
  // system always defaulting to Browser Use for every new session.
  const ordered = preferred ? [...LANES].sort((a, b) => (a.provider === preferred ? -1 : b.provider === preferred ? 1 : 0)) : LANES;
  for (const lane of ordered) {
    if (!used.has(`${lane.provider}:${lane.slot}`)) return lane;
  }
  throw new Error(
    'All browser lanes (browser_use, steel, brightdata) are already in use for this chat -- call browser_stop on an existing session_id before starting another, or reuse an existing session_id as a follow-up.',
  );
}

/** True for errors that mean "this provider account itself can't run anything right now" (quota/billing), as opposed to a one-off task failure -- only these are worth silently falling back to the other lane for. */
function isProviderUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b402\b|plan limit|quota|insufficient credit/i.test(msg);
}

function isDone(result: BrowserUseSessionResult): boolean {
  return result.isTaskSuccessful !== null && result.isTaskSuccessful !== undefined;
}

function outputToText(output: unknown): string | null {
  if (output == null) return null;
  return typeof output === 'string' ? output : JSON.stringify(output);
}

// --- Browser Use Cloud lane -------------------------------------------------

async function runBrowserUseLane(params: {
  task: string;
  slot: BrowserUseSlot;
  providerSessionId?: string;
  rowId: string;
  priorSteps: unknown;
}): Promise<{
  providerSessionId: string;
  liveUrl: string | null;
  output: string | null;
  screenshotUrl: string | null;
  isTaskSuccessful: boolean | null;
  stillRunning: boolean;
  recordingUrl: string | null;
}> {
  const result = await createOrDispatchBrowserUseTask(params.slot, { task: params.task, sessionId: params.providerSessionId, keepAlive: true });
  let finalResult = result;
  let stillRunning = !isDone(finalResult);
  let steps = params.priorSteps;
  let messageCursor: string | undefined = (() => {
    const arr = Array.isArray(params.priorSteps) ? (params.priorSteps as StepEntry[]) : [];
    return arr.length ? arr[arr.length - 1]?.id : undefined;
  })();
  const startedAt = Date.now();

  // Immediately persist the live view + running status so the Browser
  // tab shows the iframe right away, well before the first poll tick --
  // matters most for a brand new session (result.id === providerSessionId).
  await prisma.chatBrowserSession
    .update({ where: { id: params.rowId }, data: { liveUrl: finalResult.liveUrl ?? undefined, status: stillRunning ? 'running' : 'idle' } })
    .catch(() => {});

  async function pollMessagesAndPersist() {
    try {
      const msgs = await listBrowserUseMessages(params.slot, result.id, messageCursor);
      if (msgs.length === 0) return;
      messageCursor = msgs[msgs.length - 1].id;
      const newSteps: StepEntry[] = msgs.map(m => ({ id: m.id, role: m.role, summary: m.summary, screenshotUrl: m.screenshotUrl, at: new Date().toISOString() }));
      steps = appendSteps(steps, newSteps);
      await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } });
    } catch {
      // Message streaming is a nice-to-have live feed -- never fail the whole tool call over it.
    }
  }

  await pollMessagesAndPersist();
  while (stillRunning && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      finalResult = await getBrowserUseSession(params.slot, result.id);
    } catch {
      break;
    }
    stillRunning = !isDone(finalResult);
    await pollMessagesAndPersist();
  }

  return {
    providerSessionId: result.id,
    liveUrl: finalResult.liveUrl,
    output: outputToText(finalResult.output) ?? finalResult.lastStepSummary,
    screenshotUrl: finalResult.screenshotUrl,
    isTaskSuccessful: finalResult.isTaskSuccessful,
    stillRunning,
    recordingUrl: finalResult.recordingUrls[0] ?? null,
  };
}

// --- Steel lane (we drive it ourselves) -------------------------------------

const SteelActionSchema = z.object({
  done: z.boolean().describe('True once the task is fully complete or has definitively failed.'),
  success: z.boolean().optional().describe('When done=true: whether the task actually succeeded.'),
  summary: z.string().optional().describe('When done=true: concise markdown summary of the outcome, for the end user.'),
  stepDescription: z.string().describe('One short sentence describing this step (shown in the UI).'),
  action: z
    .enum(['goto', 'click', 'fill', 'press', 'scroll_down', 'scroll_up', 'wait_ms', 'switch_tab'])
    .optional()
    .describe('The single next action. Omit only when done=true.'),
  selector: z
    .string()
    .optional()
    .describe('Playwright locator string for click/fill (e.g. "text=Submit", "role=button[name=\'Log in\']", "css=#email"). Required for click/fill.'),
  value: z
    .string()
    .optional()
    .describe('Payload: URL for goto, text to fill, key name for press, ms amount for scroll/wait_ms, tab index (0-based, newest last) for switch_tab.'),
});
type SteelAction = z.infer<typeof SteelActionSchema>;

/**
 * UPDATED (2026-07-17, "improve the whole browser to be better x3"):
 * decisions are now VISION-based (a live screenshot is sent alongside the
 * text) instead of text-only. Text-only decisions were genuinely brittle
 * -- no sense of layout, visibility, what's actually clickable vs. just
 * present in the DOM, dismissible overlays/cookie banners sitting on top
 * of the target element, etc. -- exactly the kind of thing a screenshot
 * makes obvious at a glance. Deliberately pinned to an explicit
 * vision-capable Gateway alias (openai/gpt-4o-mini) for this call rather
 * than the shared fast-default resolver in gateway.ts, since that
 * default (claude-3.5-haiku) does NOT support image input at all --
 * confirmed against Anthropic's own model card before wiring this up, to
 * avoid silently shipping a call that 400s on every single image it's
 * given. Still honors ctx.byokModel when set (see browser_use.ts's call
 * site), so a user's own configured model is used first if they have one.
 */
/** Finds the first balanced {...} substring in free-form text (handles ```json fences, leading/trailing prose, etc.) and JSON.parses it. Returns null rather than throwing on anything unparseable. */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * ADDED (2026-07-17, real production failure: "Browser automation
 * stopped: the controlling model kept returning invalid responses (model
 * did not return a valid next action)" on the Steel lane with a BYOK
 * relay model, e.g. Kie.ai's Grok 4.5 `/grok/v1/responses` relay).
 *
 * generateObject's structured-output strategy (tool-calling or a
 * provider's native JSON-schema response format, depending on the model)
 * only works if the actual provider on the other end of the wire honors
 * whatever param the AI SDK sends for it. Some third-party relays mimic
 * an official API's request/response SHAPE closely enough to pass as
 * that provider to the SDK, but don't implement every param faithfully
 * -- if the relay silently drops/ignores the structured-output
 * instruction, the model just replies in free-form prose every single
 * time, and generateObject has no way to recover no matter how many
 * attempts or how strongly the prompt insists on JSON, since the
 * REQUEST itself never carried a working structured-output constraint.
 *
 * This fallback sidesteps that entirely: plain generateText (the single
 * most universally-supported call shape across every chat completion
 * API/relay, structured-output support or not), the schema spelled out
 * as plain-English instructions in the prompt instead of a param the
 * relay might ignore, and manual JSON extraction from the raw text
 * response. Deliberately text-only (no image) -- a model/relay that
 * already can't manage structured JSON output is even less likely to
 * reliably combine that with vision reasoning.
 */
async function decideStepViaPlainText(params: {
  llmModel: Parameters<typeof generateObject>[0]['model'];
  task: string;
  history: string[];
  pageText: string;
  url: string;
  tabCount: number;
  lastBadText: string;
}): Promise<SteelAction | null> {
  const { text } = await generateText({
    model: params.llmModel,
    system:
      'You control a real remote web browser one action at a time via Playwright locators. You are given the task, steps ' +
      'taken so far, the current URL, number of open tabs, and the visible text of the current page. Decide the SINGLE ' +
      'next action needed to make progress.\n\n' +
      'Respond with ONLY a single raw JSON object (no markdown code fences, no explanation before or after it) matching ' +
      'exactly this shape:\n' +
      '{"done": boolean, "success": boolean (only if done=true), "summary": string (only if done=true, concise markdown ' +
      'outcome summary), "stepDescription": string (one short sentence describing this step), ' +
      '"action": one of "goto"|"click"|"fill"|"press"|"scroll_down"|"scroll_up"|"wait_ms"|"switch_tab" (omit only when ' +
      'done=true), "selector": Playwright locator string for click/fill e.g. "text=Submit", "role=button[name=\'Log in\']", ' +
      '"css=#email" (required for click/fill), "value": URL for goto, text to fill, key name for press, ms amount for ' +
      'scroll/wait_ms, or tab index (0-based, newest last) for switch_tab}.\n\n' +
      'Only set done=true once the task is genuinely complete, or cannot be completed after reasonable attempts (then ' +
      'success=false and explain why in summary).',
    messages: [
      {
        role: 'user',
        content:
          `Task: ${params.task}\n\nSteps so far (${params.history.length}): ${params.history.join('; ') || '(none yet)'}\n\n` +
          `Current URL: ${params.url}\nOpen tabs: ${params.tabCount}\nVisible page text (truncated):\n${params.pageText.slice(0, 4000)}` +
          (params.lastBadText
            ? `\n\nA previous attempt to get this as structured output failed; here is that raw (invalid) response for reference, in case it helps: ${params.lastBadText.slice(0, 500)}`
            : ''),
      },
    ],
  });
  const parsed = extractJsonObject(text);
  if (parsed == null) return null;
  const result = SteelActionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function decideSteelAction(params: {
  llmModel: Parameters<typeof generateObject>[0]['model'];
  task: string;
  history: string[];
  pageText: string;
  url: string;
  tabCount: number;
  screenshotBase64: string;
}) {
  const MAX_ATTEMPTS = 3;
  let lastBadText = '';
  // Not every BYOK model/relay behind `params.llmModel` supports image
  // input -- e.g. a text-only model proxied through a compatibility
  // relay may reject an image content part outright (400-style error,
  // not a NoObjectGeneratedError). Rather than aborting the whole Steel
  // task the first time that happens, drop back to text-only and retry
  // the SAME step once before giving up on it.
  let includeImage = true;
  let triedNoImageFallback = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const base =
      `Task: ${params.task}\n\nSteps so far (${params.history.length}): ${params.history.join('; ') || '(none yet)'}\n\n` +
      `Current URL: ${params.url}\nOpen tabs: ${params.tabCount}\nVisible page text (truncated):\n${params.pageText.slice(0, 4000)}` +
      (includeImage
        ? '\n\nA screenshot of the current page state is attached -- use it to judge what is actually visible/clickable ' +
          '(watch for cookie banners, modals, or popups covering the target) rather than relying on the text alone.'
        : '');
    const textContent =
      attempt === 0
        ? base
        : `${base}\n\nIMPORTANT: your previous response was not valid JSON matching the schema. Respond with ONLY strict JSON, no markdown fences, no commentary.${lastBadText ? `\n\nYour last (invalid) response: ${lastBadText.slice(0, 500)}` : ''}`;
    const content: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> = [{ type: 'text', text: textContent }];
    if (includeImage) content.push({ type: 'file', data: params.screenshotBase64, mediaType: 'image/png' });
    try {
      const { object } = await generateObject({
        model: params.llmModel,
        schema: SteelActionSchema,
        system:
          'You control a real remote web browser one action at a time via Playwright locators. You are given the task, ' +
          'steps taken so far, the current URL, number of open tabs, the visible text of the current page' +
          (includeImage ? ', AND a screenshot of what the page actually looks like right now' : '') +
          '. Decide the SINGLE next action needed to make progress, using a ' +
          'Playwright locator string for selector (text=, role=, css=, id=). If a new tab opened (e.g. after clicking a link ' +
          'that opens target=_blank) and open tabs > 1, use switch_tab with the tab index to move to the new tab before ' +
          'continuing. Only set done=true once the task is genuinely complete, or cannot be completed after reasonable ' +
          'attempts (then success=false and explain why).',
        messages: [{ role: 'user', content }],
      });
      return { ok: true as const, action: object };
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        lastBadText = err.text ?? '';
        // A model/relay that replies with prose instead of valid JSON is
        // very often being visibly distracted by the attached screenshot
        // (small/relay-proxied models tend to describe an image
        // narratively rather than emit strict structured output when one
        // is present) -- drop it after the FIRST bad-JSON response, not
        // only on an outright request-level rejection, before burning
        // through the remaining attempts still including it.
        if (includeImage && !triedNoImageFallback) {
          includeImage = false;
          triedNoImageFallback = true;
        }
        continue;
      }
      if (includeImage && !triedNoImageFallback) {
        includeImage = false;
        triedNoImageFallback = true;
        attempt--;
        continue;
      }
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // Every generateObject attempt (tool-calling / provider JSON-schema
  // response format) failed to produce parseable structured output --
  // some BYOK relays mimic a real provider's shape closely enough to
  // pass the SDK's provider check without actually honoring the
  // structured-output param, so no amount of retrying THAT call shape
  // will ever succeed. Fall back to plain generateText + manual JSON
  // extraction (see decideStepViaPlainText's doc comment) before giving
  // up on the whole task over it.
  try {
    const fallbackAction = await decideStepViaPlainText({
      llmModel: params.llmModel,
      task: params.task,
      history: params.history,
      pageText: params.pageText,
      url: params.url,
      tabCount: params.tabCount,
      lastBadText,
    });
    if (fallbackAction) return { ok: true as const, action: fallbackAction };
  } catch (err) {
    return { ok: false as const, reason: `plain-text fallback also failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: false as const, reason: 'model did not return a valid next action (structured output and plain-text JSON fallback both failed)' };
}

async function runSteelLane(params: {
  task: string;
  websocketUrl: string;
  llmModel: Parameters<typeof generateObject>[0]['model'];
  rowId: string;
  priorSteps: unknown;
}): Promise<{
  output: string | null;
  screenshotUrl: string | null;
  isTaskSuccessful: boolean | null;
}> {
  const browser = await connectSteelBrowser(params.websocketUrl);
  let steps = params.priorSteps;
  try {
    const context = browser.contexts()[0];
    // Track every tab as it opens (e.g. target=_blank links) instead of
    // only ever driving the tab the session started on -- popups used to
    // just get silently ignored since `page` was captured once and never
    // updated, so a task that opened a new tab would stall watching a
    // background page while the actual content loaded somewhere else.
    let tabs: import('playwright-core').Page[] = [...context.pages()];
    if (tabs.length === 0) tabs = [await context.newPage()];
    let activeIdx = tabs.length - 1;
    context.on('page', newPage => {
      tabs.push(newPage);
      activeIdx = tabs.length - 1;
    });
    const currentPage = () => tabs[activeIdx] ?? tabs[tabs.length - 1];

    const history: string[] = [];
    let outcome: { done: boolean; success?: boolean; summary?: string } = { done: false };

    async function captureScreenshotBase64(): Promise<string> {
      try {
        const buf = await currentPage().screenshot({ timeout: 5000 });
        return buf.toString('base64');
      } catch {
        return '';
      }
    }

    async function captureAndUploadScreenshot(): Promise<string | null> {
      try {
        const buf = await currentPage().screenshot({ timeout: 5000 });
        const blob = await put(`browser-steel/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`, buf, { access: 'public', contentType: 'image/png' });
        return blob.url;
      } catch {
        return null;
      }
    }

    let screenshotBase64 = await captureScreenshotBase64();

    for (let i = 0; i < MAX_STEEL_STEPS; i++) {
      const pageText = await currentPage()
        .locator('body')
        .innerText({ timeout: 5000 })
        .catch(() => '');
      const decision = await decideSteelAction({
        llmModel: params.llmModel,
        task: params.task,
        history,
        pageText,
        url: currentPage().url(),
        tabCount: tabs.length,
        screenshotBase64,
      });
      if (!decision.ok) {
        outcome = { done: true, success: false, summary: `Browser automation stopped: the controlling model kept returning invalid responses (${decision.reason}).` };
        steps = appendSteps(steps, [{ role: 'ai', summary: outcome.summary!, screenshotUrl: null, at: new Date().toISOString() }]);
        await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});
        break;
      }
      const next: SteelAction = decision.action;
      if (next.done) {
        const finalShotUrl = await captureAndUploadScreenshot();
        outcome = { done: true, success: next.success, summary: next.summary };
        steps = appendSteps(steps, [
          { role: 'ai', summary: next.summary || (next.success ? 'Task completed.' : 'Task did not complete.'), screenshotUrl: finalShotUrl, at: new Date().toISOString() },
        ]);
        await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});
        break;
      }
      let stepText: string;
      try {
        switch (next.action) {
          case 'goto':
            if (next.value) await currentPage().goto(next.value, { waitUntil: 'domcontentloaded', timeout: 20000 });
            break;
          case 'click': {
            if (next.selector) {
              // Scroll-into-view-then-retry once: the single most common
              // cause of a click failing outright wasn't a bad selector,
              // it was the element existing but sitting off-screen or
              // under a sticky header/overlay -- worth one cheap retry
              // before giving up and reporting the step as failed.
              const locator = currentPage().locator(next.selector).first();
              try {
                await locator.click({ timeout: 8000 });
              } catch (firstErr) {
                await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await locator.click({ timeout: 5000, force: true }).catch(() => {
                  throw firstErr;
                });
              }
            }
            break;
          }
          case 'fill':
            if (next.selector && next.value !== undefined) await currentPage().locator(next.selector).first().fill(next.value, { timeout: 8000 });
            break;
          case 'press':
            if (next.value) await currentPage().keyboard.press(next.value);
            break;
          case 'scroll_down':
            await currentPage().mouse.wheel(0, Number(next.value) || 500);
            break;
          case 'scroll_up':
            await currentPage().mouse.wheel(0, -(Number(next.value) || 500));
            break;
          case 'wait_ms':
            await currentPage().waitForTimeout(Number(next.value) || 1000);
            break;
          case 'switch_tab': {
            const idx = Number(next.value);
            if (Number.isInteger(idx) && idx >= 0 && idx < tabs.length) activeIdx = idx;
            break;
          }
        }
        history.push(next.stepDescription);
        stepText = next.stepDescription;
      } catch (err) {
        const failText = `${next.stepDescription} — FAILED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        history.push(failText);
        stepText = failText;
      }

      // Screenshot AFTER the action so both (a) this step's entry in the
      // live feed shows the resulting page state, matching the visual
      // parity Browser Use's own message stream already had, and (b) the
      // very same capture is reused as the NEXT iteration's "what does
      // the page look like right now" input -- one screenshot per loop
      // tick, not two.
      const stepShotUrl = await captureAndUploadScreenshot();
      screenshotBase64 = await captureScreenshotBase64();

      // Persisted live, one entry per action, so the Browser tab's step
      // feed updates in near-real-time while this loop is still running
      // (previously the whole steps history only ever showed up once the
      // entire tool call had already finished).
      steps = appendSteps(steps, [{ role: 'ai', summary: stepText, screenshotUrl: stepShotUrl, at: new Date().toISOString() }]);
      await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});

      if (i === MAX_STEEL_STEPS - 1 && !outcome.done) {
        outcome = { done: true, success: false, summary: `Stopped after ${MAX_STEEL_STEPS} steps without the task reporting completion.` };
      }
    }

    let screenshotUrl: string | null = null;
    try {
      const buffer = await currentPage().screenshot();
      const blob = await put(`browser-steel/${Date.now()}.png`, buffer, { access: 'public', contentType: 'image/png' });
      screenshotUrl = blob.url;
    } catch {
      // A failed final screenshot shouldn't fail the whole task result.
    }

    return { output: outcome.summary ?? (outcome.success ? 'Task completed.' : 'The task did not complete successfully.'), screenshotUrl, isTaskSuccessful: outcome.success ?? false };
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- Bright Data lane (raw CDP, we drive it ourselves -- same decide/act loop as Steel) ----

async function runBrightDataLane(params: {
  task: string;
  llmModel: Parameters<typeof generateObject>[0]['model'];
  rowId: string;
  priorSteps: unknown;
}): Promise<{
  output: string | null;
  screenshotUrl: string | null;
  isTaskSuccessful: boolean | null;
  liveUrl: string | null;
}> {
  const browser = await connectBrightDataBrowser();
  let steps = params.priorSteps;
  let liveUrl: string | null = null;
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    let tabs: import('playwright-core').Page[] = [...context.pages()];
    if (tabs.length === 0) tabs = [await context.newPage()];
    let activeIdx = tabs.length - 1;
    context.on('page', newPage => {
      tabs.push(newPage);
      activeIdx = tabs.length - 1;
    });
    const currentPage = () => tabs[activeIdx] ?? tabs[tabs.length - 1];

    // Persist the live DevTools inspect URL as soon as we have a page, so
    // the Browser tab can show something real-time right away instead of
    // only after the whole task finishes -- same "show it live" intent
    // as the other two lanes' liveUrl, just fetched via a CDP round-trip
    // since Bright Data doesn't hand one back from a create-session call
    // (there is no create-session call at all here).
    liveUrl = await getLiveInspectUrl(currentPage());
    if (liveUrl) {
      await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { liveUrl } }).catch(() => {});
    }

    const history: string[] = [];
    let outcome: { done: boolean; success?: boolean; summary?: string } = { done: false };

    async function captureScreenshotBase64(): Promise<string> {
      try {
        const buf = await currentPage().screenshot({ timeout: 5000 });
        return buf.toString('base64');
      } catch {
        return '';
      }
    }

    async function captureAndUploadScreenshot(): Promise<string | null> {
      try {
        const buf = await currentPage().screenshot({ timeout: 5000 });
        const blob = await put(`browser-brightdata/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`, buf, { access: 'public', contentType: 'image/png' });
        return blob.url;
      } catch {
        return null;
      }
    }

    let screenshotBase64 = await captureScreenshotBase64();

    for (let i = 0; i < MAX_STEEL_STEPS; i++) {
      const pageText = await currentPage()
        .locator('body')
        .innerText({ timeout: 5000 })
        .catch(() => '');
      const decision = await decideSteelAction({
        llmModel: params.llmModel,
        task: params.task,
        history,
        pageText,
        url: currentPage().url(),
        tabCount: tabs.length,
        screenshotBase64,
      });
      if (!decision.ok) {
        outcome = { done: true, success: false, summary: `Browser automation stopped: the controlling model kept returning invalid responses (${decision.reason}).` };
        steps = appendSteps(steps, [{ role: 'ai', summary: outcome.summary!, screenshotUrl: null, at: new Date().toISOString() }]);
        await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});
        break;
      }
      const next: SteelAction = decision.action;
      if (next.done) {
        const finalShotUrl = await captureAndUploadScreenshot();
        outcome = { done: true, success: next.success, summary: next.summary };
        steps = appendSteps(steps, [
          { role: 'ai', summary: next.summary || (next.success ? 'Task completed.' : 'Task did not complete.'), screenshotUrl: finalShotUrl, at: new Date().toISOString() },
        ]);
        await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});
        break;
      }
      let stepText: string;
      const idxBefore = activeIdx;
      try {
        switch (next.action) {
          case 'goto':
            if (next.value) await currentPage().goto(next.value, { waitUntil: 'domcontentloaded', timeout: 20000 });
            break;
          case 'click': {
            if (next.selector) {
              const locator = currentPage().locator(next.selector).first();
              try {
                await locator.click({ timeout: 8000 });
              } catch (firstErr) {
                await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await locator.click({ timeout: 5000, force: true }).catch(() => {
                  throw firstErr;
                });
              }
            }
            break;
          }
          case 'fill':
            if (next.selector && next.value !== undefined) await currentPage().locator(next.selector).first().fill(next.value, { timeout: 8000 });
            break;
          case 'press':
            if (next.value) await currentPage().keyboard.press(next.value);
            break;
          case 'scroll_down':
            await currentPage().mouse.wheel(0, Number(next.value) || 500);
            break;
          case 'scroll_up':
            await currentPage().mouse.wheel(0, -(Number(next.value) || 500));
            break;
          case 'wait_ms':
            await currentPage().waitForTimeout(Number(next.value) || 1000);
            break;
          case 'switch_tab': {
            const idx = Number(next.value);
            if (Number.isInteger(idx) && idx >= 0 && idx < tabs.length) activeIdx = idx;
            break;
          }
        }
        history.push(next.stepDescription);
        stepText = next.stepDescription;
      } catch (err) {
        const failText = `${next.stepDescription} — FAILED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        history.push(failText);
        stepText = failText;
      }

      const stepShotUrl = await captureAndUploadScreenshot();
      screenshotBase64 = await captureScreenshotBase64();

      // A tab switch means the live DevTools inspect URL from earlier now
      // points at the WRONG tab -- refresh it so the Browser tab's live
      // view follows whichever tab is actually active.
      if (activeIdx !== idxBefore) {
        const newLiveUrl = await getLiveInspectUrl(currentPage());
        if (newLiveUrl && newLiveUrl !== liveUrl) {
          liveUrl = newLiveUrl;
          await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { liveUrl } }).catch(() => {});
        }
      }

      steps = appendSteps(steps, [{ role: 'ai', summary: stepText, screenshotUrl: stepShotUrl, at: new Date().toISOString() }]);
      await prisma.chatBrowserSession.update({ where: { id: params.rowId }, data: { steps: steps as object } }).catch(() => {});

      if (i === MAX_STEEL_STEPS - 1 && !outcome.done) {
        outcome = { done: true, success: false, summary: `Stopped after ${MAX_STEEL_STEPS} steps without the task reporting completion.` };
      }
    }

    let screenshotUrl: string | null = null;
    try {
      const buffer = await currentPage().screenshot();
      const blob = await put(`browser-brightdata/${Date.now()}.png`, buffer, { access: 'public', contentType: 'image/png' });
      screenshotUrl = blob.url;
    } catch {
      // A failed final screenshot shouldn't fail the whole task result.
    }

    return { output: outcome.summary ?? (outcome.success ? 'Task completed.' : 'The task did not complete successfully.'), screenshotUrl, isTaskSuccessful: outcome.success ?? false, liveUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- Tool --------------------------------------------------------------------

export const browserUse = {
  description:
    'Drive a real cloud browser to complete a task: navigate, click, fill forms, read pages, extract data. Give it a ' +
    "natural-language task; it runs in a live, watchable cloud browser (the chat UI's Browser tab shows it in real " +
    "time, plus a live step-by-step feed of what it's doing) and returns a summary when done. For browser_use/steel, " +
    'the browser stays alive after the task finishes -- pass the returned session_id back in to send a FOLLOW-UP task ' +
    'in the SAME browser (same cookies/tabs/page state) instead of starting fresh; call browser_stop when genuinely ' +
    'finished with one of those. brightdata is different: it is ONE-SHOT ONLY -- the task runs to completion (or its ' +
    'step limit) and the browser closes at the end of this same call, no session_id follow-up is supported for it ' +
    '(the underlying provider has no way to reattach to an already-open browser instance). Up to three sessions can ' +
    'run in parallel for this chat, one per cloud browser provider -- pass `provider` to pick which one for a NEW ' +
    'session (defaults to trying browser_use first, auto-falling back to steel if browser_use\'s account itself is ' +
    'unavailable, e.g. out of quota).',
  inputSchema: z.object({
    task: z.string().describe('Natural-language description of what the browser should do next.'),
    session_id: z
      .string()
      .optional()
      .describe(
        'An existing browser session id (returned by a previous browser_use call) to send this task as a follow-up in the SAME live browser. Only ' +
          'valid for browser_use/steel sessions -- brightdata sessions are one-shot and cannot be resumed. Omit to start a brand new session.',
      ),
    provider: z
      .enum(['browser_use', 'steel', 'brightdata'])
      .optional()
      .describe(
        'Force a specific provider for a NEW session: "browser_use" (fully agentic, hands-off -- its own agent plans and executes the whole task), ' +
          '"steel" (a raw remote Chrome, driven one action at a time by this tool, resumable via session_id), or "brightdata" (another raw remote ' +
          "Chrome driven the same way, but ONE-SHOT ONLY -- no session_id follow-up). Omit to auto-pick (tries browser_use first, falls back to " +
          "steel automatically if browser_use's account can't run anything right now, e.g. out of quota). Ignored when session_id is given -- a " +
          "follow-up always reuses that session's existing provider.",
      ),
  }),
  async execute({ task, session_id, provider }: { task: string; session_id?: string; provider?: 'browser_use' | 'steel' | 'brightdata' }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;

    let row: SessionRow | null = null;
    let lane: Lane;

    if (session_id) {
      const existing = await prisma.chatBrowserSession.findUnique({ where: { id: session_id } });
      if (!existing || existing.chatId !== chatId) throw new Error(`No browser session "${session_id}" found for this chat.`);
      if (existing.status === 'stopped') throw new Error(`Browser session "${session_id}" was already stopped -- omit session_id to start a new one.`);
      row = existing as SessionRow;
      lane =
        existing.provider === 'steel'
          ? { provider: 'steel', slot: 1 }
          : existing.provider === 'brightdata'
            ? { provider: 'brightdata', slot: 1 }
            : { provider: 'browser_use', slot: existing.slot as BrowserUseSlot };
    } else {
      lane = await pickFreeLane(chatId, provider);
    }

    let fellBackToSteel = false;

    if (lane.provider === 'browser_use') {
      // Create the row up front (before the lane even starts polling) so
      // an incremental step feed has somewhere to write to from the very
      // first tick -- for a brand-new session this starts as a
      // placeholder and gets its real providerSessionId/liveUrl filled
      // in a moment later by runBrowserUseLane itself.
      if (!row) {
        row = (await prisma.chatBrowserSession.create({
          data: { chatId, provider: 'browser_use', slot: lane.slot, providerSessionId: 'pending', task, status: 'running', steps: [] },
        })) as SessionRow;
      }

      let laneResult: Awaited<ReturnType<typeof runBrowserUseLane>> | null = null;
      try {
        laneResult = await runBrowserUseLane({
          task,
          slot: lane.slot,
          providerSessionId: row.providerSessionId === 'pending' ? undefined : row.providerSessionId,
          rowId: row.id,
          priorSteps: row.steps,
        });
      } catch (err) {
        // Never leave a lane permanently "stuck" occupied by a row that
        // failed before it ever got a real provider session id -- mark
        // it failed so pickFreeLane frees the slot back up immediately.
        await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'failed' } }).catch(() => {});

        // AUTO-FALLBACK (2026-07-17, explicit user request: "make it easy
        // for agent to call steel browser and the browser use -- currently
        // all call go to browser use"): browser_use was always tried first
        // for every brand-new session, so if that account itself can't run
        // anything right now (quota/billing, not a one-off task failure),
        // silently retry the SAME task on Steel instead of just failing the
        // whole call -- only for a genuinely new session (never a
        // session_id follow-up, which must stick to its already-established
        // provider) and only when Steel's own lane is actually free.
        const steelFree =
          !session_id &&
          (await prisma.chatBrowserSession.count({ where: { chatId, provider: 'steel', slot: 1, status: { in: ['running', 'idle'] } } })) === 0;
        if (!session_id && steelFree && isProviderUnavailableError(err)) {
          fellBackToSteel = true;
        } else {
          throw err;
        }
      }

      if (fellBackToSteel) {
        row = null;
        lane = { provider: 'steel', slot: 1 };
        // Falls through to the Steel section below -- deliberately no
        // `return` here, this is the one case where lane switches mid-call.
      } else {
        const finalResult = laneResult!;
        row = (await prisma.chatBrowserSession.update({
          where: { id: row.id },
          data: {
            task,
            providerSessionId: finalResult.providerSessionId,
            status: finalResult.stillRunning ? 'running' : 'idle',
            liveUrl: finalResult.liveUrl ?? row.liveUrl,
            output: finalResult.output ?? row.output,
            isTaskSuccessful: finalResult.isTaskSuccessful ?? row.isTaskSuccessful,
            recordingUrl: finalResult.recordingUrl ?? row.recordingUrl,
          },
        })) as SessionRow;

        const markdown = finalResult.stillRunning
          ? `Still working in a live browser (session \`${row.id}\`) -- it keeps running even though this tool call is reporting back now. Call browser_use again with session_id "${row.id}" to check progress or continue, or browser_stop to end it.`
          : finalResult.output || (finalResult.isTaskSuccessful ? 'Task completed.' : 'The task did not complete successfully.');

        return {
          status: finalResult.stillRunning ? 'running' : finalResult.isTaskSuccessful === false ? 'failed' : 'finished',
          steps: [],
          screenshotUrl: finalResult.screenshotUrl,
          markdown,
          sessionId: row.id,
          liveUrl: row.liveUrl,
          recordingUrl: row.recordingUrl,
          provider: 'browser_use',
        };
      }
    }

    if (lane.provider === 'steel') {
      let websocketUrl: string;
      let liveUrl: string | null;

      if (row) {
        const meta = (row.metadata ?? {}) as { websocketUrl?: string };
        if (!meta.websocketUrl) throw new Error(`Browser session "${row.id}" is missing its Steel connection info -- start a new session instead.`);
        websocketUrl = meta.websocketUrl;
        liveUrl = row.liveUrl;
      } else {
        const session = await createSteelSession();
        websocketUrl = session.websocketUrl;
        liveUrl = session.liveUrl;
        row = (await prisma.chatBrowserSession.create({
          data: {
            chatId,
            provider: 'steel',
            slot: 1,
            providerSessionId: session.id,
            metadata: { websocketUrl },
            task,
            status: 'running',
            liveUrl,
            steps: [],
          },
        })) as SessionRow;
      }

      // Pinned to a vision-capable alias -- see decideSteelAction's doc
      // comment for why the shared fast-default resolver can't be used here.
      const llmModel = await model('openai/gpt-4o-mini', ctx?.byokModel);
      let laneResult: Awaited<ReturnType<typeof runSteelLane>>;
      try {
        laneResult = await runSteelLane({ task, websocketUrl, llmModel, rowId: row.id, priorSteps: row.steps });
      } catch (err) {
        // FIXED (2026-07-17): previously nothing caught an error thrown out
        // of runSteelLane, so a hard failure (e.g. a Playwright-level
        // crash, not just a bad-step outcome which runSteelLane already
        // handles internally) left the row stuck on status 'running'
        // forever -- pickFreeLane would then think the Steel lane was
        // permanently occupied for this chat. Mirrors the browser_use
        // lane's existing failure handling just above.
        await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'failed' } }).catch(() => {});
        throw err;
      }

      row = (await prisma.chatBrowserSession.update({
        where: { id: row.id },
        data: { task, status: 'idle', output: laneResult.output, isTaskSuccessful: laneResult.isTaskSuccessful },
      })) as SessionRow;

      const fallbackNote = fellBackToSteel
        ? 'Note: browser_use is unavailable right now (e.g. out of quota), so this ran on the Steel browser lane instead. '
        : '';

      return {
        status: laneResult.isTaskSuccessful === false ? 'failed' : 'finished',
        steps: [],
        screenshotUrl: laneResult.screenshotUrl,
        markdown: fallbackNote + (laneResult.output ?? ''),
        sessionId: row.id,
        liveUrl: row.liveUrl,
        recordingUrl: row.recordingUrl,
        provider: 'steel',
      };
    }

    // --- Bright Data lane (one-shot: always runs the task to completion in
    // this same call, then closes -- see brightdata-client.ts's doc comment
    // for why no session_id follow-up is offered here) ---
    if (!row) {
      row = (await prisma.chatBrowserSession.create({
        data: { chatId, provider: 'brightdata', slot: 1, providerSessionId: `brightdata-${Date.now()}`, task, status: 'running', steps: [] },
      })) as SessionRow;
    }

    const llmModelBd = await model('openai/gpt-4o-mini', ctx?.byokModel);
    let bdResult: Awaited<ReturnType<typeof runBrightDataLane>>;
    try {
      bdResult = await runBrightDataLane({ task, llmModel: llmModelBd, rowId: row.id, priorSteps: row.steps });
    } catch (err) {
      await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'failed' } }).catch(() => {});
      throw err;
    }

    row = (await prisma.chatBrowserSession.update({
      where: { id: row.id },
      // Always 'stopped', not 'idle' -- there is nothing left alive to
      // reconnect to once this call returns, so the lane should free up
      // immediately for the next brightdata task (see the one-shot note
      // in the tool description above).
      data: { task, status: 'stopped', output: bdResult.output, isTaskSuccessful: bdResult.isTaskSuccessful, liveUrl: bdResult.liveUrl ?? row.liveUrl },
    })) as SessionRow;

    return {
      status: bdResult.isTaskSuccessful === false ? 'failed' : 'finished',
      steps: [],
      screenshotUrl: bdResult.screenshotUrl,
      markdown: bdResult.output ?? '',
      sessionId: row.id,
      liveUrl: row.liveUrl,
      recordingUrl: null,
      provider: 'brightdata',
    };
  },
};

browserUse.execute = safeExecute('browser_use', browserUse.execute) as typeof browserUse.execute;
