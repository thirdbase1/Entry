import { runs } from '@trigger.dev/sdk/v3';
import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import { prisma } from '@entry/db';
import { setBackgroundRunActive, setBackgroundRunId } from '@entry/copilot';

/**
 * BACKGROUND HANDOFF WATCHDOG (2026-07-22)
 *
 * Real bug, confirmed live: the background handoff in route.ts calls
 * `agentTurnOrchestratorTask.trigger(...)`, which only rejects if the
 * *enqueue* call itself fails (network/API error to Trigger.dev). It does
 * NOT reject if Trigger.dev accepts the run (returns a run id) but that
 * run then never actually starts executing -- observed directly:
 * multiple runs sat in `PENDING_VERSION` for over an hour despite the
 * deployed worker version being confirmed the current one (via
 * `trigger.dev promote`, which reports "already the current deployment"),
 * and despite Trigger.dev's own status page showing everything
 * operational. Root cause looks account/project-side on Trigger.dev, not
 * fixable from here -- but regardless of WHY, the user-facing failure
 * mode without this watchdog is silent, permanent hang: the chat's
 * "background run active" flag gets set true and then never gets cleared,
 * so the client just waits forever with no error, no completion, nothing.
 *
 * This polls the just-created run for a bounded window; if it never
 * leaves the queued/pending state and starts executing, it tears down
 * the background-run flags and appends a real, visible error message to
 * the chat so the user sees an honest explanation instead of dead air.
 */
const WATCHDOG_TIMEOUT_MS = 45_000;
const WATCHDOG_POLL_MS = 3_000;

export async function watchForStuckBackgroundRun(chatId: string, runId: string): Promise<void> {
  const deadline = Date.now() + WATCHDOG_TIMEOUT_MS;
  let started = false;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, WATCHDOG_POLL_MS));
    try {
      const run = await runs.retrieve(runId);
      if (run.isExecuting || run.isCompleted || run.isFailed) {
        started = true;
        break;
      }
    } catch (pollErr) {
      console.error('[direct chat] background watchdog poll failed', chatId, runId, pollErr);
    }
  }

  if (started) return;

  console.error('[direct chat] background run never left the queue -- treating handoff as failed', chatId, runId);
  await setBackgroundRunActive(chatId, false);
  await setBackgroundRunId(chatId, null);
  await appendBackgroundHandoffFailureMessage(chatId);
}

async function appendBackgroundHandoffFailureMessage(chatId: string): Promise<void> {
  try {
    const session = await prisma.eveChatSession.findUnique({ where: { id: chatId } });
    if (!session) return;
    const existing = Array.isArray(session.events) ? (session.events as unknown as UIMessage[]) : [];
    const failureMessage: UIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text:
            'This turn needed more time than a single request allows, so it was handed off to run in the ' +
            "background -- but the background run never actually started (this is an infrastructure issue, " +
            "not something wrong with your message). Nothing was lost: whatever had already been saved before " +
            'the handoff is still here. Please send your message again to continue.',
          state: 'done',
        },
      ],
    } as UIMessage;
    await prisma.eveChatSession.update({
      where: { id: chatId },
      data: { events: [...existing, failureMessage] as any },
    });
  } catch (err) {
    console.error('[direct chat] failed to append background-handoff failure message', chatId, err);
  }
}
