import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { logError } from '@entry/db/error-log';
import { buildModelClient } from '@/lib/byok/build-model-client';
import { describeApiCallError } from '@/lib/direct-chat/describe-api-error';

/**
 * POST /api/user/byok/providers/:providerId/models/:modelId/test-reasoning
 *
 * "Instantly test the model reasoning as I toggle it on" (2026-07-25,
 * explicit ask). Deliberately a SEPARATE endpoint from the sibling
 * .../test route (plain connectivity check, no reasoning forced) --
 * this one specifically forces reasoning on with the exact same
 * broad-compatibility passthrough production chat now uses (see
 * route.ts's/direct-chat-core.ts's 2026-07-25 comments) and inspects
 * whether real reasoning content actually came back, which is a genuinely
 * different question from "did it answer at all".
 *
 * Always responds 200 with `{ status: 'success' | 'no_reasoning' | 'error', ... }`
 * -- a model/relay that doesn't expose thinking, or a real upstream
 * failure, are both expected outcomes here, not server errors, exactly
 * like the sibling /test route's own design.
 *
 * Result persists onto the model row's dedicated
 * lastReasoningTestedAt/lastReasoningTestStatus/lastReasoningTestError/
 * lastReasoningTokens columns (separate from the plain-connectivity
 * lastTestStatus/lastTestError) so the settings page can show both
 * independently and the status survives a reload.
 */
export const POST = withApiErrorHandling(async (
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; modelId: string }> }
) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId, modelId } = await params;
  const modelRow = await prisma.userModelProviderModel.findFirst({
    where: { id: modelId, providerId, provider: { userId: session.user.id } },
    include: { provider: true },
  });
  if (!modelRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { provider } = modelRow;

  let apiKey: string | undefined;
  if (provider.encryptedApiKey) {
    try {
      apiKey = decryptApiKey(provider.encryptedApiKey);
    } catch (err) {
      const message = `Your saved API key for "${provider.label}" could not be read (likely re-encrypted with a different server key) — please re-enter it in Settings > Providers.`;
      logError({
        source: 'byok-test-reasoning-decrypt-failed',
        error: err,
        userId: session.user.id,
        context: { providerId, modelId, providerLabel: provider.label },
      });
      await prisma.userModelProviderModel.update({
        where: { id: modelRow.id },
        data: { lastReasoningTestedAt: new Date(), lastReasoningTestStatus: 'error', lastReasoningTestError: message },
      });
      return NextResponse.json({ status: 'error', error: message });
    }
  }

  const model = buildModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelRow.modelId,
    { userId: session.user.id }
  );

  // Same 60s ceiling as the sibling /test route -- reasoning models
  // routinely take longer than a plain reply, confirmed live there.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let result: { status: 'success' | 'no_reasoning' | 'error'; reasoningText?: string; reasoningTokens?: number; error?: string };
  try {
    const { reasoningText, text, totalUsage } = await generateText({
      model,
      // A prompt that only a model actually "thinking" would need real
      // steps for -- makes it obvious in the reasoning trace (if any
      // comes back) whether genuine step-by-step reasoning happened,
      // rather than a one-word reply that a reasoning model might answer
      // instantly without ever engaging its thinking budget.
      messages: [{ role: 'user', content: 'What is 17 * 24? Work through the multiplication step by step, then give the final number.' }],
      maxOutputTokens: 1000,
      // Force reasoning on exactly like a real chat turn with the toggle
      // enabled would -- same portable option AND the same broad
      // provider-agnostic passthrough (enable_thinking / thinking.type)
      // production chat now sends, so this test reflects reality instead
      // of testing a narrower path than what actually gets used.
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
      // The call succeeded and produced a real answer, but zero reasoning
      // content came back despite asking -- not an error (the model did
      // respond), just a clear signal this specific model/relay doesn't
      // expose thinking even with the toggle on. Distinct from 'error' so
      // the UI can show an honest amber warning instead of a red failure.
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
      userId: session.user.id,
      context: { providerId, modelId, providerLabel: provider.label, aborted: controller.signal.aborted },
    });
  } finally {
    clearTimeout(timeout);
  }

  await prisma.userModelProviderModel.update({
    where: { id: modelRow.id },
    data: {
      lastReasoningTestedAt: new Date(),
      lastReasoningTestStatus: result.status,
      lastReasoningTestError: result.status === 'success' ? null : (result.error ?? null),
      lastReasoningTokens: result.reasoningTokens ?? null,
    },
  });

  return NextResponse.json(result);
});
