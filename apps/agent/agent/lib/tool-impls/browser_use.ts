import { generateObject, NoObjectGeneratedError } from 'ai';
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

/**
 * FIXED (2026-07-15, explicit user report: "browser_use failed: No object
 * generated: could not parse the response" after two tool calls, whole
 * page reloaded): `generateObject` had ZERO retry/repair here -- the very
 * first time the deciding model's raw output didn't parse as strict JSON
 * matching NextActionSchema (extremely common with faster/cheaper BYOK
 * models: markdown code fences around the JSON, a trailing comment, one
 * missing required field), the AI SDK throws `NoObjectGeneratedError`
 * straight out of this loop. `safeExecute` (see that file) stops that
 * from tearing down the whole in-flight turn, but it still turns EVERY
 * browser_use call into a single hard failure with no chance to
 * self-correct -- exactly what was reported. Real fix: retry a bounded
 * number of times, and on each retry after the first, append the model's
 * own bad raw output (`NoObjectGeneratedError.text`) plus an explicit
 * "that was invalid, fix it" instruction -- the same repair pattern the
 * AI SDK docs themselves recommend for this exact error
 * (ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error).
 * Only after every retry is exhausted does this now return a normal
 * "step failed, stopping cleanly" outcome instead of throwing -- so a
 * genuinely uncooperative model degrades the browser_use call to "gave up
 * gracefully with an explanation" rather than "crashed."
 */
async function generateNextAction(params: {
  llmModel: Parameters<typeof generateObject>[0]['model'];
  system: string;
  task: string;
  steps: StepResult[];
  pageState: string;
}): Promise<{ ok: true; next: NextAction } | { ok: false; reason: string }> {
  const MAX_ATTEMPTS = 3;
  let lastBadText = '';
  let lastErrorMessage = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const baseContent =
      `Task: ${params.task}\n\n` +
      `Steps so far (${params.steps.length}): ${params.steps.map((s, idx) => `${idx + 1}. ${s.description}`).join('; ') || '(none yet)'}\n\n` +
      `Current page snapshot:\n${params.pageState}`;
    const content =
      attempt === 0
        ? baseContent
        : `${baseContent}\n\n` +
          `IMPORTANT: your previous response could not be parsed as valid JSON matching the required schema. ` +
          `Respond with ONLY strict, valid JSON matching the schema -- no markdown code fences, no commentary, ` +
          `no trailing text before or after the JSON object.` +
          (lastBadText ? `\n\nYour last (invalid) response was:\n${lastBadText.slice(0, 500)}` : '');
    try {
      const { object: next } = await generateObject({
        model: params.llmModel,
        schema: NextActionSchema,
        system: params.system,
        messages: [{ role: 'user', content }],
      });
      return { ok: true, next };
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        lastBadText = err.text ?? '';
        lastErrorMessage = err.message;
        continue; // retry with the repair prompt above
      }
      // Any other error (network, provider outage, auth) isn't something a
      // repair prompt can fix -- no point burning retries on it.
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  return { ok: false, reason: lastErrorMessage || 'model did not return a valid next action' };
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

    // FIXED (2026-07-15, confirmed live against a real E2B sandbox): every
    // single browser_use call was failing with "Auto-launch failed: CDP
    // command timed out: Page.enable" -- 100% reproduction rate, first
    // call onward, not something that only shows up after N calls. Root
    // cause: agent-browser launches Chrome with its normal (sandboxed)
    // process model by default, and Chrome's own internal setuid/user-ns
    // sandbox cannot initialize inside E2B's container (confirmed:
    // launching the same Chrome binary manually with --no-sandbox
    // responds to CDP immediately; without it, CDP never comes up).
    // agent-browser exposes exactly one documented escape hatch for this
    // ("--args", or its env-var form) -- this is the standard
    // headless-Chrome-in-a-container fix (same flags Puppeteer's own
    // Docker docs recommend), not anything specific to this app.
    const AGENT_BROWSER_ENV = {
      AGENT_BROWSER_ARGS: '--no-sandbox,--disable-dev-shm-usage,--disable-gpu',
    };

    async function runCli(args: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
      const res = await sandbox.run({
        command: `agent-browser --session ${shellQuote(session)} ${args}`,
        env: AGENT_BROWSER_ENV,
      });
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

      const decision = await generateNextAction({
        llmModel,
        system:
          'You control a real web browser one action at a time via a CLI. You will be given the ' +
          'overall task, the history of steps already taken, and the current page snapshot (JSON with ' +
          '"refs" mapping @eN -> {name, role} and a readable "snapshot" tree). Decide the SINGLE next ' +
          'action needed to make progress. Only set done=true once the task is genuinely complete, and ' +
          'include a clear summary of the outcome. If the task cannot be completed after reasonable ' +
          "attempts, set done=true, success=false, and explain why in summary. Prefer find_text_click " +
          "when a ref is not obviously the right target. Never invent a ref that is not present in the " +
          "snapshot's refs map.",
        task,
        steps,
        pageState,
      });

      if (!decision.ok) {
        // Every repair attempt failed -- stop cleanly instead of throwing
        // (see generateNextAction's own comment). The caller/model still
        // gets a normal, informative result instead of a crashed turn.
        finalStatus = 'failed';
        finalMarkdown = `Browser automation stopped: the controlling model kept returning an invalid response and could not be repaired (${decision.reason}). ${steps.length ? `Completed ${steps.length} step(s) before stopping.` : ''}`;
        break;
      }
      const next = decision.next;

      if (next.done) {
        finalStatus = next.success === false ? 'failed' : 'finished';
        finalMarkdown = next.summary || (finalStatus === 'failed' ? 'The task could not be completed.' : 'Task completed.');
        break;
      }

      const cmd = buildCommand(next);
      let stepDescription = next.stepDescription;
      if (cmd) {
        const result = await runCli(cmd);
        if (!result.ok) {
          // FIXED (2026-07-13): a failed action (bad ref, element not
          // clickable, navigation error, ...) used to be silently
          // swallowed — the loop just moved on to the next iteration as
          // if nothing happened, so the model never learned its action
          // didn't work and would often repeat the same failing action
          // until MAX_STEPS ran out. Surface the real stderr in the step
          // description so it flows into next iteration's "Steps so far"
          // context and the model can actually self-correct.
          stepDescription = `${stepDescription} — FAILED: ${result.stderr.slice(0, 300) || 'no output'}`;
        }
      } else {
        // buildCommand returned null: the model picked an action but
        // omitted a required field (e.g. "click" with no ref). Previously
        // this also just silently did nothing for a full step.
        stepDescription = `${stepDescription} — SKIPPED: action "${next.action}" was missing a required ref/value, nothing was executed.`;
      }
      const shot = await takeScreenshot();
      steps.push({ description: stepDescription, screenshotUrl: shot });

      if (i === MAX_STEPS - 1) {
        finalStatus = 'failed';
        finalMarkdown = `Stopped after ${MAX_STEPS} steps without the task reporting completion. Last state: ${stepDescription}`;
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
