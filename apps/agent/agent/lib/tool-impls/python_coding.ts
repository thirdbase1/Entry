import { generateText } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
import { withTransientRetry } from '../transient-provider-error.js';

function stripCodeFence(raw: string): string {
  let stripped = raw.trim();
  if (stripped.startsWith('```')) {
    const firstNewline = stripped.indexOf('\n');
    if (firstNewline !== -1) stripped = stripped.slice(firstNewline + 1);
    if (stripped.endsWith('```')) stripped = stripped.slice(0, -3);
  }
  return stripped;
}

// See with-timeout-signal.ts / code_artifact.ts's identical constant.
const TIMEOUT_MS = 75_000;

export const pythonCoding = {
  description: 'Generate Python code that satisfies a natural-language requirements description.',
  inputSchema: z.object({
    requirements: z.string().describe('The requirements to generate python code for'),
  }),
  async execute({ requirements }: { requirements: string }, ctx?: ToolExecCtx) {
    // FIXED (2026-07-15, real bug: "AI just stays stuck working on a long
    // file, nothing happens") — this used to be `generateObject` against a
    // `{ code: string, explanation?: string }` zod schema. Structured
    // output forces the model to emit the code as a JSON STRING (every
    // newline/quote backslash-escaped, burning extra output tokens per
    // line versus plain text) inside one JSON object that is only valid
    // once its closing brace/quote actually arrives. The moment "code"
    // needed to hold anything long (e.g. requirements that describe
    // reproducing/editing a large existing file inline), it reliably hit
    // the model's own output-token ceiling mid-string: the JSON never
    // closes, `generateObject` cannot parse a partial object at all, so
    // the whole call rejects with NoObjectGeneratedError — no code, no
    // file write, no visible progress, exactly the reported "stuck,
    // nothing happened" symptom (repeated silent failures look that way
    // to a user watching the chat, even though each individual call does
    // reject rather than literally hang).
    // `generateText` + a plain fenced code block (same proven pattern as
    // this file's sibling tool-impl, code_artifact.ts) has no such
    // failure mode: plain text has zero escaping overhead (more actual
    // code fits before the same output-token ceiling), and even a
    // response that DOES get cut off by the ceiling is still a usable,
    // inspectable partial script instead of an unparseable, thrown-away
    // JSON fragment. `maxOutputTokens` is also raised explicitly here
    // (previously unset, so silently whatever the SDK/provider default
    // happened to be for whichever fast model `model()` resolves to) --
    // real headroom instead of an undocumented ceiling.
    //
    // UPDATED (2026-07-16) — added the same internal timeout guard
    // code_artifact.ts got (see with-timeout-signal.ts): bounds worst-case
    // latency for this call itself instead of letting a slow/hung upstream
    // model ride along until the outer request's own maxDuration silently
    // kills the whole turn.
    //
    // UPDATED (2026-07-17, "improve the whole AI process for long term
    // task") — two more real gaps this shares with browser_use.ts/
    // tool-impls/agent.ts's rewrites: zero retry on a transient upstream
    // capacity error (one blip used to fail the whole tool call outright,
    // same class of bug fixed there), and no signal at all when the
    // output actually got cut off by `maxOutputTokens` mid-file (the
    // caller previously had no way to distinguish "here's the complete
    // script" from "here's the first 8192 tokens of it"). Both fixed the
    // same way: shared `withTransientRetry` wrapping a per-attempt fresh
    // timeout window, and `truncated: finishReason === 'length'` in the
    // return value.
    const { text, finishReason } = await withTransientRetry(async () => {
      const t = withTimeoutSignal(ctx?.abortSignal, TIMEOUT_MS, 'python_coding');
      try {
        return await generateText({
          model: await model(undefined, ctx?.byokModel),
          abortSignal: t.signal,
          maxOutputTokens: 8192,
          // See task_analysis.ts's comment -- top-level `system`, not an
          // embedded `role: 'system'` message, is what actually survives
          // translation into Responses-API-style providers.
          system:
            'Write complete, runnable Python code that satisfies the given requirements. ' +
            'Respond with ONLY the code in a single fenced ```python code block, no explanation ' +
            'before or after it. For editing an existing long file, write a short, targeted script ' +
            '(read the file, make precise string/regex replacements, write it back) rather than ' +
            'reproducing the whole file as one inline string literal.',
          messages: [{ role: 'user', content: requirements }],
        });
      } catch (err) {
        throw t.rethrow(err);
      } finally {
        t.clear();
      }
    });

    const code = stripCodeFence(text);
    const truncated = finishReason === 'length';
    return {
      code,
      truncated,
      note: truncated
        ? 'Output was cut off by the token limit before finishing — this script is likely incomplete. Ask for it in smaller parts, or a shorter/simpler version.'
        : undefined,
    };
  },
};

pythonCoding.execute = safeExecute('python_coding', pythonCoding.execute) as typeof pythonCoding.execute;
