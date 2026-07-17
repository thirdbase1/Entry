import { z } from 'zod';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { prisma } from '@entry/db';
import { put } from '@vercel/blob';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import {
  createOrDispatchBrowserUseTask,
  getBrowserUseSession,
  type BrowserUseSlot,
  type BrowserUseSessionResult,
} from '../browser-use-cloud-client.js';
import { createSteelSession, connectSteelBrowser } from '../steel-client.js';

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
 * pickFreeLane always tries Browser Use's two slots before Steel's one,
 * since Browser Use needs zero extra code here (its own agent does the
 * work) while Steel costs an LLM call per step -- cheaper/faster by
 * default, but all three genuinely run in parallel across different
 * chat turns/tasks since each is tracked as its own ChatBrowserSession row.
 */

const POLL_INTERVAL_MS = 3000;
// How long THIS tool call keeps polling/stepping before reporting back --
// NOT the browser's own lifetime. Both providers keep the session alive
// well past this on their own (Browser Use's keepAlive, Steel's
// timeout/inactivityTimeout), so a long task doesn't get killed just
// because this loop gave up watching -- exactly "the browser should
// still be active" from the request. Call back in with session_id to
// keep going.
const WALL_CLOCK_BUDGET_MS = 60_000;
const MAX_STEEL_STEPS = 12;

type Lane = { provider: 'browser_use'; slot: BrowserUseSlot } | { provider: 'steel'; slot: 1 };

const LANES: Lane[] = [
  { provider: 'browser_use', slot: 1 },
  { provider: 'browser_use', slot: 2 },
  { provider: 'steel', slot: 1 },
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
};

async function pickFreeLane(chatId: string): Promise<Lane> {
  const active = await prisma.chatBrowserSession.findMany({
    where: { chatId, status: { in: ['running', 'idle'] } },
    select: { provider: true, slot: true },
  });
  const used = new Set(active.map(a => `${a.provider}:${a.slot}`));
  for (const lane of LANES) {
    if (!used.has(`${lane.provider}:${lane.slot}`)) return lane;
  }
  throw new Error(
    'All three browser lanes (browser_use slots 1/2, steel slot 1) are already in use for this chat -- call browser_stop on an existing session_id before starting another, or reuse an existing session_id as a follow-up.',
  );
}

function isDone(result: BrowserUseSessionResult): boolean {
  return result.isTaskSuccessful !== null && result.isTaskSuccessful !== undefined;
}

function outputToText(output: unknown): string | null {
  if (output == null) return null;
  return typeof output === 'string' ? output : JSON.stringify(output);
}

// --- Browser Use Cloud lane -------------------------------------------------

async function runBrowserUseLane(params: { task: string; slot: BrowserUseSlot; providerSessionId?: string }): Promise<{
  providerSessionId: string;
  liveUrl: string | null;
  output: string | null;
  screenshotUrl: string | null;
  isTaskSuccessful: boolean | null;
  stillRunning: boolean;
}> {
  const result = await createOrDispatchBrowserUseTask(params.slot, { task: params.task, sessionId: params.providerSessionId, keepAlive: true });
  let finalResult = result;
  let stillRunning = !isDone(finalResult);
  const startedAt = Date.now();
  while (stillRunning && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      finalResult = await getBrowserUseSession(params.slot, result.id);
    } catch {
      break;
    }
    stillRunning = !isDone(finalResult);
  }
  return {
    providerSessionId: result.id,
    liveUrl: finalResult.liveUrl,
    output: outputToText(finalResult.output) ?? finalResult.lastStepSummary,
    screenshotUrl: finalResult.screenshotUrl,
    isTaskSuccessful: finalResult.isTaskSuccessful,
    stillRunning,
  };
}

// --- Steel lane (we drive it ourselves) -------------------------------------

const SteelActionSchema = z.object({
  done: z.boolean().describe('True once the task is fully complete or has definitively failed.'),
  success: z.boolean().optional().describe('When done=true: whether the task actually succeeded.'),
  summary: z.string().optional().describe('When done=true: concise markdown summary of the outcome, for the end user.'),
  stepDescription: z.string().describe('One short sentence describing this step (shown in the UI).'),
  action: z.enum(['goto', 'click', 'fill', 'press', 'scroll_down', 'scroll_up', 'wait_ms']).optional().describe('The single next action. Omit only when done=true.'),
  selector: z
    .string()
    .optional()
    .describe('Playwright locator string for click/fill (e.g. "text=Submit", "role=button[name=\'Log in\']", "css=#email"). Required for click/fill.'),
  value: z.string().optional().describe('Payload: URL for goto, text to fill, key name for press, ms amount for scroll/wait_ms.'),
});
type SteelAction = z.infer<typeof SteelActionSchema>;

async function decideSteelAction(params: { llmModel: Parameters<typeof generateObject>[0]['model']; task: string; history: string[]; pageText: string; url: string }) {
  const MAX_ATTEMPTS = 3;
  let lastBadText = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const base =
      `Task: ${params.task}\n\nSteps so far (${params.history.length}): ${params.history.join('; ') || '(none yet)'}\n\n` +
      `Current URL: ${params.url}\nVisible page text (truncated):\n${params.pageText.slice(0, 4000)}`;
    const content =
      attempt === 0
        ? base
        : `${base}\n\nIMPORTANT: your previous response was not valid JSON matching the schema. Respond with ONLY strict JSON, no markdown fences, no commentary.${lastBadText ? `\n\nYour last (invalid) response: ${lastBadText.slice(0, 500)}` : ''}`;
    try {
      const { object } = await generateObject({
        model: params.llmModel,
        schema: SteelActionSchema,
        system:
          'You control a real remote web browser one action at a time via Playwright locators. You are given the task, ' +
          'steps taken so far, the current URL, and the visible text of the current page. Decide the SINGLE next action ' +
          'needed to make progress, using a Playwright locator string for selector (text=, role=, css=, id=). Only set ' +
          'done=true once the task is genuinely complete, or cannot be completed after reasonable attempts (then ' +
          'success=false and explain why).',
        messages: [{ role: 'user', content }],
      });
      return { ok: true as const, action: object };
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        lastBadText = err.text ?? '';
        continue;
      }
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false as const, reason: 'model did not return a valid next action' };
}

async function runSteelLane(params: { task: string; websocketUrl: string; llmModel: Parameters<typeof generateObject>[0]['model'] }): Promise<{
  output: string | null;
  screenshotUrl: string | null;
  isTaskSuccessful: boolean | null;
}> {
  const browser = await connectSteelBrowser(params.websocketUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    const history: string[] = [];
    let outcome: { done: boolean; success?: boolean; summary?: string } = { done: false };

    for (let i = 0; i < MAX_STEEL_STEPS; i++) {
      const pageText = await page
        .locator('body')
        .innerText({ timeout: 5000 })
        .catch(() => '');
      const decision = await decideSteelAction({ llmModel: params.llmModel, task: params.task, history, pageText, url: page.url() });
      if (!decision.ok) {
        outcome = { done: true, success: false, summary: `Browser automation stopped: the controlling model kept returning invalid responses (${decision.reason}).` };
        break;
      }
      const next: SteelAction = decision.action;
      if (next.done) {
        outcome = { done: true, success: next.success, summary: next.summary };
        break;
      }
      try {
        switch (next.action) {
          case 'goto':
            if (next.value) await page.goto(next.value, { waitUntil: 'domcontentloaded', timeout: 20000 });
            break;
          case 'click':
            if (next.selector) await page.locator(next.selector).first().click({ timeout: 8000 });
            break;
          case 'fill':
            if (next.selector && next.value !== undefined) await page.locator(next.selector).first().fill(next.value, { timeout: 8000 });
            break;
          case 'press':
            if (next.value) await page.keyboard.press(next.value);
            break;
          case 'scroll_down':
            await page.mouse.wheel(0, Number(next.value) || 500);
            break;
          case 'scroll_up':
            await page.mouse.wheel(0, -(Number(next.value) || 500));
            break;
          case 'wait_ms':
            await page.waitForTimeout(Number(next.value) || 1000);
            break;
        }
        history.push(next.stepDescription);
      } catch (err) {
        history.push(`${next.stepDescription} — FAILED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      }
      if (i === MAX_STEEL_STEPS - 1 && !outcome.done) {
        outcome = { done: true, success: false, summary: `Stopped after ${MAX_STEEL_STEPS} steps without the task reporting completion.` };
      }
    }

    let screenshotUrl: string | null = null;
    try {
      const buffer = await page.screenshot();
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

// --- Tool --------------------------------------------------------------------

export const browserUse = {
  description:
    'Drive a real cloud browser to complete a task: navigate, click, fill forms, read pages, extract data. Give it a ' +
    "natural-language task; it runs in a live, watchable cloud browser (the chat UI's Browser tab shows it in real " +
    "time) and returns a summary when done. The browser stays alive after the task finishes -- pass the returned " +
    'session_id back in to send a FOLLOW-UP task in the SAME browser (same cookies/tabs/page state) instead of ' +
    'starting fresh. Call browser_stop when genuinely finished with a session. Up to three sessions can run in ' +
    'parallel for this chat, across two different cloud browser providers.',
  inputSchema: z.object({
    task: z.string().describe('Natural-language description of what the browser should do next.'),
    session_id: z
      .string()
      .optional()
      .describe(
        'An existing browser session id (returned by a previous browser_use call) to send this task as a follow-up in the SAME live browser. Omit to start a brand new session.',
      ),
  }),
  async execute({ task, session_id }: { task: string; session_id?: string }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;

    let row: SessionRow | null = null;
    let lane: Lane;

    if (session_id) {
      const existing = await prisma.chatBrowserSession.findUnique({ where: { id: session_id } });
      if (!existing || existing.chatId !== chatId) throw new Error(`No browser session "${session_id}" found for this chat.`);
      if (existing.status === 'stopped') throw new Error(`Browser session "${session_id}" was already stopped -- omit session_id to start a new one.`);
      row = existing;
      lane = existing.provider === 'steel' ? { provider: 'steel', slot: 1 } : { provider: 'browser_use', slot: existing.slot as BrowserUseSlot };
    } else {
      lane = await pickFreeLane(chatId);
    }

    if (lane.provider === 'browser_use') {
      const laneResult = await runBrowserUseLane({ task, slot: lane.slot, providerSessionId: row?.providerSessionId });

      row = row
        ? await prisma.chatBrowserSession.update({
            where: { id: row.id },
            data: {
              task,
              status: laneResult.stillRunning ? 'running' : 'idle',
              liveUrl: laneResult.liveUrl ?? row.liveUrl,
              output: laneResult.output ?? row.output,
              isTaskSuccessful: laneResult.isTaskSuccessful ?? row.isTaskSuccessful,
            },
          })
        : await prisma.chatBrowserSession.create({
            data: {
              chatId,
              provider: 'browser_use',
              slot: lane.slot,
              providerSessionId: laneResult.providerSessionId,
              task,
              status: laneResult.stillRunning ? 'running' : 'idle',
              liveUrl: laneResult.liveUrl,
              output: laneResult.output,
              isTaskSuccessful: laneResult.isTaskSuccessful,
            },
          });

      const markdown = laneResult.stillRunning
        ? `Still working in a live browser (session \`${row.id}\`) -- it keeps running even though this tool call is reporting back now. Call browser_use again with session_id "${row.id}" to check progress or continue, or browser_stop to end it.`
        : laneResult.output || (laneResult.isTaskSuccessful ? 'Task completed.' : 'The task did not complete successfully.');

      return {
        status: laneResult.stillRunning ? 'running' : laneResult.isTaskSuccessful === false ? 'failed' : 'finished',
        steps: [],
        screenshotUrl: laneResult.screenshotUrl,
        markdown,
        sessionId: row.id,
        liveUrl: row.liveUrl,
        provider: 'browser_use',
      };
    }

    // --- Steel lane ---
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
      row = await prisma.chatBrowserSession.create({
        data: {
          chatId,
          provider: 'steel',
          slot: 1,
          providerSessionId: session.id,
          metadata: { websocketUrl },
          task,
          status: 'running',
          liveUrl,
        },
      });
    }

    const llmModel = await model(undefined, ctx?.byokModel);
    const laneResult = await runSteelLane({ task, websocketUrl, llmModel });

    row = await prisma.chatBrowserSession.update({
      where: { id: row.id },
      data: { task, status: 'idle', output: laneResult.output, isTaskSuccessful: laneResult.isTaskSuccessful },
    });

    return {
      status: laneResult.isTaskSuccessful === false ? 'failed' : 'finished',
      steps: [],
      screenshotUrl: laneResult.screenshotUrl,
      markdown: laneResult.output,
      sessionId: row.id,
      liveUrl: row.liveUrl,
      provider: 'steel',
    };
  },
};

browserUse.execute = safeExecute('browser_use', browserUse.execute) as typeof browserUse.execute;
