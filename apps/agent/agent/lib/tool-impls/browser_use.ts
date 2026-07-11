import { generateObject } from 'ai';
import { z } from 'zod';
import { put } from '@vercel/blob';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/**
 * REWRITTEN (2026-07-11) — the previous implementation shelled out to
 * `agent-browser --session <id> chat "<task>" --json`. Confirmed by
 * reading agent-browser's own real CLI reference (`agent-browser skills
 * get core`, installed v0.31.1): there is no `chat` subcommand at all.
 * agent-browser is a deliberately LOW-LEVEL, step-by-step CLI (open,
 * snapshot, click, fill, screenshot, ...) meant to be driven turn-by-turn
 * by an agent loop — not a one-shot "give it a task, get a result" API
 * like browser-use.com (which is what the old renderer's output shape —
 * currentStatus/stepsInfo/finalGif — was actually ported from). Every
 * call to the old implementation failed outright (unknown subcommand),
 * which is the real, confirmed cause of "browser use doesn't work".
 *
 * This is a real fix, not a patch: it implements the missing agent loop
 * itself, right here, using the same fast/cheap model plumbing every
 * other internal sub-generation tool in this file already uses (see
 * gateway.ts's `model()`).
 *
 * Loop, each iteration:
 *   1. Take a snapshot of the current page (`snapshot -i --json`) — gives
 *      the deciding model real, current `@eN` refs to act on.
 *   2. Ask the model (structured output) for exactly one next action, or
 *      to declare the task done/failed with a final summary.
 *   3. Execute that one action as a real agent-browser command.
 *   4. Take a screenshot after every action and upload it to Vercel Blob
 *      (same storage already used for avatars/copilot files — see
 *      @entry/copilot's own `put()` usage) so the chat UI can actually
 *      render it (a temp-dir local path on the sandbox is not reachable
 *      by the browser at all — this was ALSO silently broken in the
 *      renderer's assumptions before, since it expected a `screenshot`/
 *      `gif` field to already be a fetchable URL).
 *   5. Feed the step + screenshot into the running `steps` list returned
 *      to the model/UI, and loop until the model reports done/failed or
 *      MAX_STEPS is hit (hard safety cap — this is real browser
 *      automation against the live web, not a bounded local script).
 */

const MAX_STEPS = 14;

const NextActionSchema = z.object({
  done: z.boolean().describe('True if the task is fully complete (or has definitively failed) and no more actions are needed.'),
  success: z.boolean().optional().describe('When done=true: whether the task actually succeeded (vs. failed/gave up).'),
  summary: z
    .string()
    .optional()
    .describe('When done=true: a concise markdown summary of what was found/accomplished, written for the end user.'),
  stepDescription: z
    .string()
    .describe('One short, human-readable sentence describing this step (e.g. "Opening the login page", "Clicking Submit"). Shown directly in the UI.'),
  action: z
    .enum([
      'open',
      'click',
      'fill',
      'type',
      'press',
      'select',
      'check',
      'uncheck',
      'hover',
      'scroll_down',
      'scroll_up',
      'find_text_click',
      'go_back',
      'wait_text',
      'wait_ms',
    ])
    .optional()
    .describe('The single next action to perform. Omit only when done=true.'),
  ref: z.string().optional().describe('Element ref from the last snapshot, e.g. "@e3" — required for click/fill/type/hover/select/check/uncheck.'),
  value: z
    .string()
    .optional()
    .describe('Action payload: URL for open, text to fill/type, key name for press, option value for select, text to search for wait_text/find_text_click, ms amount for scroll/wait_ms.'),
});
type NextAction = z.infer<typeof NextActionSchema>;

interface StepResult {
  description: string;
  screenshotUrl: string | null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Maps one structured action into a real agent-browser CLI invocation. */
function buildCommand(action: NextAction): string | null {
  const ref = action.ref ? shellQuote(action.ref) : undefined;
  const val = action.value !== undefined ? shellQuote(action.value) : undefined;
  switch (action.action) {
    case 'open':
      return val ? `open ${val}` : null;
    case 'click':
      return ref ? `click ${ref}` : null;
    case 'fill':
      return ref && val ? `fill ${ref} ${val}` : null;
    case 'type':
      return ref && val ? `type ${ref} ${val}` : null;
    case 'press':
      return val ? `press ${val}` : null;
    case 'select':
      return ref && val ? `select ${ref} ${val}` : null;
    case 'check':
      return ref ? `check ${ref}` : null;
    case 'uncheck':
      return ref ? `uncheck ${ref}` : null;
    case 'hover':
      return ref ? `hover ${ref}` : null;
    case 'scroll_down':
      return `scroll down ${action.value ? shellQuote(action.value) : '500'}`;
    case 'scroll_up':
      return `scroll up ${action.value ? shellQuote(action.value) : '500'}`;
    case 'find_text_click':
      return val ? `find text ${val} click` : null;
    case 'go_back':
      return `back`;
    case 'wait_text':
      return val ? `wait --text ${val}` : null;
    case 'wait_ms':
      return `wait ${action.value ? shellQuote(action.value) : '1000'}`;
    default:
      return null;
  }
}

export const browserUse = {
  description:
    'Autonomously drive a real Chrome browser to complete a task: navigate, click, fill forms, ' +
    'read page content, take screenshots. Give it a natural-language task description; it plans ' +
    'and executes the necessary browser steps itself (one real page snapshot + action per step) ' +
    'and returns a markdown summary plus screenshots of every step taken.',
  inputSchema: z.object({
    task: z.string().describe('Natural-language description of what the browser should accomplish'),
    startUrl: z.string().optional().describe('Optional URL to open first, if known — saves the model a step.'),
  }),
  async execute({ task, startUrl }: { task: string; startUrl?: string }, ctx: ToolExecCtx) {
    const sandbox = await ctx.getSandbox();
    const session = `browser-use-${sandbox.id}`;
    const llmModel = await model(undefined, ctx?.byokModel);
    const steps: StepResult[] = [];
    let finalStatus: 'finished' | 'failed' = 'finished';
    let finalMarkdown = '';

    async function runCli(args: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
      const res = await sandbox.run({ command: `agent-browser --session ${shellQuote(session)} ${args}` });
      return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
    }

    async function takeScreenshot(): Promise<string | null> {
      try {
        const fname = `/tmp/${session}-${Date.now()}.png`;
        const shot = await runCli(`screenshot ${shellQuote(fname)}`);
        if (!shot.ok) return null;
        const b64res = await sandbox.run({ command: `base64 -w0 ${shellQuote(fname)}` });
        if (b64res.exitCode !== 0 || !b64res.stdout.trim()) return null;
        const buffer = Buffer.from(b64res.stdout.trim(), 'base64');
        const blob = await put(`browser-screenshots/${session}-${Date.now()}.png`, buffer, {
          access: 'public',
          contentType: 'image/png',
        });
        return blob.url;
      } catch {
        // A failed screenshot upload should never abort the whole browser
        // task — just render that one step without an image.
        return null;
      }
    }

    if (startUrl) {
      await runCli(`open ${shellQuote(startUrl)}`);
      const shot = await takeScreenshot();
      steps.push({ description: `Opened ${startUrl}`, screenshotUrl: shot });
    }

    for (let i = 0; i < MAX_STEPS; i++) {
      const snap = await runCli('snapshot -i --json');
      const pageState = snap.ok ? snap.stdout.slice(0, 6000) : `(snapshot failed: ${snap.stderr.slice(0, 500)})`;

      const { object: next } = await generateObject({
        model: llmModel,
        schema: NextActionSchema,
        system:
          'You control a real web browser one action at a time via a CLI. You will be given the ' +
          'overall task, the history of steps already taken, and the current page snapshot (JSON with ' +
          '"refs" mapping @eN -> {name, role} and a readable "snapshot" tree). Decide the SINGLE next ' +
          'action needed to make progress. Only set done=true once the task is genuinely complete, and ' +
          'include a clear summary of the outcome. If the task cannot be completed after reasonable ' +
          "attempts, set done=true, success=false, and explain why in summary. Prefer find_text_click " +
          "when a ref is not obviously the right target. Never invent a ref that is not present in the " +
          "snapshot's refs map.",
        messages: [
          {
            role: 'user',
            content:
              `Task: ${task}\n\n` +
              `Steps so far (${steps.length}): ${steps.map((s, idx) => `${idx + 1}. ${s.description}`).join('; ') || '(none yet)'}\n\n` +
              `Current page snapshot:\n${pageState}`,
          },
        ],
      });

      if (next.done) {
        finalStatus = next.success === false ? 'failed' : 'finished';
        finalMarkdown = next.summary || (finalStatus === 'failed' ? 'The task could not be completed.' : 'Task completed.');
        break;
      }

      const cmd = buildCommand(next);
      if (cmd) {
        await runCli(cmd);
      }
      const shot = await takeScreenshot();
      steps.push({ description: next.stepDescription, screenshotUrl: shot });

      if (i === MAX_STEPS - 1) {
        finalStatus = 'failed';
        finalMarkdown = `Stopped after ${MAX_STEPS} steps without the task reporting completion. Last state: ${next.stepDescription}`;
      }
    }

    return {
      status: finalStatus,
      steps: steps.map(s => ({ description: s.description, screenshotUrl: s.screenshotUrl })),
      screenshotUrl: steps.length ? steps[steps.length - 1].screenshotUrl : null,
      markdown: finalMarkdown,
    };
  },
};

browserUse.execute = safeExecute('browser_use', browserUse.execute) as typeof browserUse.execute;
