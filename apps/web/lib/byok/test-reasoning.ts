/**
 * Shared "does this model actually return reasoning" test — extracted out
 * of the .../test-reasoning route (2026-07-25) so the SAME real check can
 * also run automatically right when a model first shows up, instead of
 * only when a user manually flips the Thinking toggle (2026-07-26, real
 * ask: "when I fetch model it should test all model reasoning, and when
 * add model id it should test it").
 *
 * Deliberately does NOT touch `reasoningEnabled` (the user's own chat
 * toggle) — this only ever writes the separate lastReasoningTest*
 * columns, so auto-testing a freshly-discovered/added model can never
 * silently turn reasoning ON for real chat turns behind the user's back.
 * It just answers "would reasoning work if I turned it on", ahead of time.
 */
import { generateText } from 'ai';
import { prisma } from '@entry/db';
import type { ByokCompatibility } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { buildModelClient } from '@/lib/byok/build-model-client';
import { describeApiCallError } from '@/lib/direct-chat/describe-api-error';

export interface ReasoningTestResult {
  status: 'success' | 'no_reasoning' | 'error';
  reasoningText?: string;
  reasoningTokens?: number;
  error?: string;
}

export async function testModelReasoning(params: {
  modelRowId: string;
  modelId: string;
  provider: { label: string; compatibility: ByokCompatibility; baseUrl: string };
  apiKey: string | undefined;
  userId: string;
}): Promise<ReasoningTestResult> {
  const { modelRowId, modelId, provider, apiKey, userId } = params;

  const model = buildModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelId,
    { userId }
  );

  // Same 60s ceiling as manual testing — reasoning models routinely take
  // longer than a plain reply, confirmed live there.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let result: ReasoningTestResult;
  try {
    const { reasoningText, text, totalUsage } = await generateText({
      model,
      messages: [{ role: 'user', content: 'What is 17 * 24? Work through the multiplication step by step, then give the final number.' }],
      maxOutputTokens: 1000,
      reasoning: 'medium',
      providerOptions: { [provider.label]: { enable_thinking: true, thinking: { type: 'enabled' } } },
      abortSignal: controller.signal,
    });

    const trimmedReasoning = reasoningText?.trim();
    if (trimmedReasoning && trimmedReasoning.length > 0) {
      result = {
        status: 'success',
        reasoningText: trimmedReasoning.slice(0, 800),
        reasoningTokens: totalUsage?.outputTokenDetails?.reasoningTokens ?? undefined,
      };
    } else {
      result = {
        status: 'no_reasoning',
        error: text?.trim()
          ? `This model answered normally ("${text.trim().slice(0, 120)}${text.trim().length > 120 ? '…' : ''}") but returned no visible reasoning/thinking content, even with it requested. It may not support extended thinking, or this relay may not expose it.`
          : 'This model returned no visible reasoning/thinking content, even with it requested, and no answer text either.',
      };
    }
  } catch (err: any) {
    const message = controller.signal.aborted
      ? `No response within 60s with reasoning enabled — this model may need more time for extended thinking, or may not support it at all. It may still work in normal chat, which allows much longer.`
      : describeApiCallError(err);
    result = { status: 'error', error: message.slice(0, 500) };
    logError({
      source: 'byok-test-reasoning-failed',
      error: err instanceof Error ? err : new Error(String(err)),
      userId,
      context: { modelRowId, modelId, providerLabel: provider.label, aborted: controller.signal.aborted },
    });
  } finally {
    clearTimeout(timeout);
  }

  await prisma.userModelProviderModel.update({
    where: { id: modelRowId },
    data: {
      lastReasoningTestedAt: new Date(),
      lastReasoningTestStatus: result.status,
      lastReasoningTestError: result.status === 'success' ? null : (result.error ?? null),
      lastReasoningTokens: result.reasoningTokens ?? null,
    },
  }).catch(err => {
    // Row could have been deleted mid-test (user removed the model while
    // an auto-test was in flight) — never let that throw out of a
    // background fire-and-forget test.
    logError({ source: 'byok-test-reasoning-persist-failed', error: err, userId, context: { modelRowId, modelId } });
  });

  return result;
}

/**
 * Fire-and-forget auto-test for a batch of newly-discovered/added models,
 * run with limited concurrency so a provider that returns dozens/hundreds
 * of models (or a slow/rate-limited relay) doesn't get hammered with one
 * simultaneous real LLM call per model. Deliberately NOT awaited by
 * callers — the fetch-models/add-model HTTP response returns immediately;
 * results land on each row's lastReasoningTest* columns as they complete,
 * same as if the user had toggled Thinking on manually.
 */
export function autoTestReasoningInBackground(
  models: { modelRowId: string; modelId: string }[],
  provider: { label: string; compatibility: ByokCompatibility; baseUrl: string },
  apiKey: string | undefined,
  userId: string,
  concurrency = 3
): void {
  if (models.length === 0) return;

  void (async () => {
    let index = 0;
    async function worker() {
      while (index < models.length) {
        const current = models[index++];
        try {
          await testModelReasoning({ modelRowId: current.modelRowId, modelId: current.modelId, provider, apiKey, userId });
        } catch (err) {
          logError({ source: 'byok-auto-test-reasoning-worker-failed', error: err, userId, context: { modelId: current.modelId } });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, () => worker()));
  })();
}
