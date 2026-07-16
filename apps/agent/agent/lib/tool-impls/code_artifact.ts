import { generateText } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';

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
    const t = withTimeoutSignal(ctx?.abortSignal, TIMEOUT_MS, 'code_artifact');
    try {
      const { text } = await generateText({
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
          'inline comments, or boilerplate that inflates length without adding real functionality.',
        messages: [{ role: 'user', content: userPrompt }],
      });

      const html = stripCodeFence(text);
      return { title, html, size: html.length };
    } catch (err) {
      throw t.rethrow(err);
    } finally {
      t.clear();
    }
  },
};

codeArtifact.execute = safeExecute('code_artifact', codeArtifact.execute) as typeof codeArtifact.execute;
