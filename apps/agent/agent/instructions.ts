import { defineInstructions } from 'eve/instructions';
import { buildPersonaInstructions } from './lib/persona.js';

/**
 * Root = shared persona only.
 *
 * There used to be a `<model_routing>` block here plus a `run_model` tool:
 * whenever the user picked a specific model in chat-config.tsx's selector,
 * the request still went to THIS agent (eve's fixed `model:`, i.e. Claude)
 * first, which was instructed to detect a `requestedModel`/`byokModelId`
 * hint in its context and immediately delegate the whole turn to
 * `run_model` instead of answering itself.
 *
 * Removed (2026-07-10) because that indirection was the actual root cause
 * of three separate real bugs: (1) `run_model` used a single blocking
 * `generateText` call, so the delegated model's answer never streamed —
 * root just relayed the whole finished text at once; (2) no reasoning/
 * thinking content was ever requested or forwarded through that relay;
 * (3) for anything conversational (e.g. "what model are you"), root would
 * sometimes just answer as itself instead of reliably delegating, so a
 * user who picked DeepSeek would get told "I'm Claude" — an instruction a
 * system prompt can ask an LLM to follow but can never fully guarantee.
 *
 * Fix: any explicit model selection (Gateway slug or BYOK) now routes to
 * apps/web/app/api/direct/chat instead, which resolves that model directly
 * and IS the whole turn's model — no relay, no possibility of a different
 * model answering identity questions on its behalf. See chat-interface.tsx
 * for the routing decision. This eve agent (root Claude, resolved via
 * model-catalog.ts) now only ever handles a turn when nothing was
 * explicitly picked (the "Default" option) — a real default, not a
 * required first hop for every turn.
 */
export default defineInstructions({
  markdown: buildPersonaInstructions(),
});
