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

// How long this tool's OWN internal model call is allowed to run before it
// fails itself, with a clear message, instead of riding along silently
// until the outer request's own maxDuration (300s, direct/chat/route.ts)
// kills the entire turn with zero error surfaced — see
// with-timeout-signal.ts. 75s leaves real headroom under 300s even as the
// last tool call in a multi-step turn, while staying generous for a
// single-file HTML artifact.
const TIMEOUT_MS = 75_000;

export const codeArtifact = {
  description:
    'Generate a single-file HTML snippet (with inline <style> and <script>) that accomplishes the ' +
    'requested functionality. The final HTML should be runnable when saved as an .html file and ' +
    'opened in a browser. Do NOT reference external resources (CSS, JS, images) except through data URIs.',
  inputSchema: z.object({
    title: z.string().describe('The title of the HTML page'),
    userPrompt: z.string().describe('The user description of the code artifact, will be used to generate the code artifact'),
  }),
  async execute({ title, userPrompt }: { title: string; userPrompt: string }, ctx?: ToolExecCtx) {
    // UPDATED (2026-07-17, "improve the whole AI process for long term
    // task") — same two fixes as python_coding.ts's identical rewrite:
    // a transient upstream capacity blip used to fail this whole call
    // outright with zero retry, and a response cut off by
    // `maxOutputTokens` (a real risk for a full single-file HTML+CSS+JS
    // document) returned silently as if it were the complete artifact.
    // `withTransientRetry` now wraps a per-attempt fresh timeout window,
    // and `truncated: finishReason === 'length'` surfaces the latter.
    const { text, finishReason } = await withTransientRetry(async () => {
      const t = withTimeoutSignal(ctx?.abortSignal, TIMEOUT_MS, 'code_artifact');
      try {
        return await generateText({
          model: await model(undefined, ctx?.byokModel),
          abortSignal: t.signal,
          // FIXED (2026-07-16, real bug: "code_artifact tool is so slow /
          // model uses it and stops without any errors") — this was the one
          // sub-generation tool-impl of the three (task_analysis,
          // code_artifact, python_coding) that never got an explicit
          // `maxOutputTokens` ceiling when python_coding got fixed for the
          // identical class of bug on 2026-07-15 (see that file's comment).
          // Unset meant whatever the SDK/provider default happened to be for
          // whichever fast model `model()` resolves to — for a full
          // single-file HTML document (markup + inline CSS + inline JS all
          // in one response) that default is frequently uncapped or very
          // high, so generation could run far longer than a user perceives
          // as reasonable, with zero visible progress the whole time. A
          // real, explicit ceiling bounds worst-case latency; combined with
          // the timeout above, a call that's still too slow now fails fast
          // and visibly instead of silently riding along until the outer
          // request's own maxDuration kills the whole turn.
          maxOutputTokens: 16000,
          // See task_analysis.ts's comment -- top-level `system`, not an
          // embedded `role: 'system'` message, is what actually survives
          // translation into Responses-API-style providers.
          system:
            'Generate a single-file HTML snippet (inline <style> and <script>, no external resources ' +
            'except data URIs) that fulfills the request. Respond with ONLY the HTML, no explanation. ' +
            'Keep it as lean as reasonably possible for the request — avoid unrequested extra features, ' +
            'inline comments, or boilerplate that inflates length without adding real functionality. ' +
            'Design quality bar (unless the request specifies otherwise): no generic AI-template look — ' +
            'no purple/blue gradient heroes, no glassmorphism-on-everything, no emoji as icons or in headings. ' +
            'Pick one accent color plus a neutral scale, one font stack (system-ui is fine), spacing on a ' +
            'consistent 4/8px rhythm, real typographic hierarchy (~16px body, ~1.5 line-height), generous ' +
            'whitespace, visible hover/focus states, semantic HTML with labeled inputs and sufficient contrast. ' +
            'Unless the request implies its own palette, START from these tokens and adjust only as needed: ' +
            ':root{--bg:#fafaf9;--surface:#fff;--text:#1c1917;--muted:#78716c;--accent:#0d9488;' +
            '--border:#e7e5e4;--radius:8px;--shadow:0 1px 3px rgb(0 0 0/.08)} ' +
            'body{font:16px/1.5 system-ui;background:var(--bg);color:var(--text);margin:0} ' +
            'Cards: surface bg, 1px border, var(--radius), var(--shadow), 16-24px padding. ' +
            'Buttons: accent bg, white text, 8px 16px padding, radius, darken ~10% on hover, ' +
            '2px accent outline-offset on focus-visible. Headings: 600 weight, tight line-height, ' +
            'sizes stepping 1.25x. Max content width 72ch, centered, 24px+ side padding.',
          messages: [{ role: 'user', content: userPrompt }],
        });
      } catch (err) {
        throw t.rethrow(err);
      } finally {
        t.clear();
      }
    });

    const html = stripCodeFence(text);
    const truncated = finishReason === 'length';
    return {
      title,
      html,
      size: html.length,
      truncated,
      note: truncated
        ? 'Output was cut off by the token limit before finishing — this HTML is likely incomplete/broken. Ask for a leaner version or split it into parts.'
        : undefined,
    };
  },
};

codeArtifact.execute = safeExecute('code_artifact', codeArtifact.execute) as typeof codeArtifact.execute;
