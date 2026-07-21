/**
 * Auto-continue wrapper around `agentTurnTask` (2026-07-21).
 *
 * Calls the worker task via `triggerAndWait`; if that run didn't finish
 * naturally -- crashed, got cut off by its own 3600s ceiling (Trigger.dev
 * kills the run; `triggerAndWait`'s result comes back `ok: false` with an
 * error/cancellation status), or the model just ran out of its own
 * per-run step/soft-deadline budget with real work still pending -- this
 * re-triggers a FRESH worker run with a synthetic "continue" user message
 * appended to whatever the worker already durably persisted to Postgres
 * (the worker's own incremental per-step save -- see agent-turn.ts --
 * means this is never re-doing lost work, only picking up from the real
 * last checkpoint).
 *
 * MAX_HOPS is the "reasonable limit for agent" the auto-continue chain is
 * bounded by: 6 chained 1h runs (~6h wall-clock ceiling total) is
 * generous for a genuinely huge multi-step task while still guaranteeing
 * this can never loop or bill forever on a model that's stuck repeating
 * itself instead of making progress.
 */
import { task } from '@trigger.dev/sdk/v3';
import { prisma } from '@entry/db';
import { setBackgroundRunActive } from '@entry/copilot';
import { agentTurnTask, type AgentTurnPayload } from './agent-turn';
import type { UIMessage } from 'ai';

const MAX_HOPS = 6;

function continueMessage(hop: number): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text:
          hop === 1
            ? 'Continue exactly where you left off. Do not repeat work you already finished -- pick up from the last thing you were doing and keep going until the task is actually complete.'
            : `Continue (auto-continue #${hop}). Same instruction: pick up exactly where you left off, do not repeat finished work, keep going until the task is genuinely done.`,
      },
    ],
  } as UIMessage;
}

export const agentTurnOrchestratorTask = task({
  id: 'agent-chat-turn-orchestrator',
  // Outer ceiling across every chained hop -- MAX_HOPS worker runs of up
  // to 3600s each, plus headroom for the triggerAndWait overhead itself.
  maxDuration: 3600 * MAX_HOPS + 600,
  run: async (payload: AgentTurnPayload) => {
    // Set once at the very start of the chain (idempotent -- the sync
    // route already sets this true itself right before enqueuing, but a
    // future direct/manual trigger of this task should still behave
    // correctly on its own) and ALWAYS cleared in the finally below, no
    // matter how this exits -- natural finish, MAX_HOPS exhausted, or an
    // uncaught throw. This is the flag direct-chat-interface.tsx's
    // recovery poll checks to know whether to keep refetching a chat
    // whose initiating HTTP response already closed.
    await setBackgroundRunActive(payload.chatId, true);
    try {
      return await runOrchestration(payload);
    } finally {
      await setBackgroundRunActive(payload.chatId, false);
    }
  },
});

async function runOrchestration(payload: AgentTurnPayload) {
  let currentMessages = payload.messages;
  let hop = 0;
  let lastResult: { finishedNaturally: boolean; finishReason?: string } | undefined;

  while (hop < MAX_HOPS) {
    const run = await agentTurnTask.triggerAndWait({ ...payload, messages: currentMessages });

    if (!run.ok) {
      // Worker run itself errored/crashed/got killed by its own hard
      // ceiling -- its own incremental per-step save is the recovery
      // point. Re-read what actually landed in Postgres (the worker's
      // last successful onStepFinish save) rather than trusting
      // anything client-side, then continue from there.
      console.error('[agent-turn orchestrator] worker run failed, re-reading persisted state to continue', payload.chatId, run.error);
      const row = await prisma.eveChatSession.findUnique({ where: { id: payload.chatId }, select: { events: true } });
      const persisted = (row?.events as unknown as UIMessage[]) ?? currentMessages;
      hop += 1;
      currentMessages = [...persisted, continueMessage(hop)];
      lastResult = { finishedNaturally: false };
      continue;
    }

    lastResult = run.output;
    if (run.output.finishedNaturally) {
      return { chatId: payload.chatId, hops: hop + 1, finishReason: run.output.finishReason, autoContinued: hop > 0 };
    }

    // Cut off (soft deadline / step cap) with real work still pending --
    // re-read the freshest persisted messages (the worker just saved
    // them in its own final save) and chain another hop.
    const row = await prisma.eveChatSession.findUnique({ where: { id: payload.chatId }, select: { events: true } });
    const persisted = (row?.events as unknown as UIMessage[]) ?? currentMessages;
    hop += 1;
    currentMessages = [...persisted, continueMessage(hop)];
  }

  console.warn('[agent-turn orchestrator] hit MAX_HOPS without a natural finish', payload.chatId, MAX_HOPS);
  return { chatId: payload.chatId, hops: hop, finishReason: lastResult?.finishedNaturally === false ? 'max-hops-reached' : lastResult?.finishReason, autoContinued: hop > 0 };
}
