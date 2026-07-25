import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { logError } from '@entry/db/error-log';
import { testModelReasoning } from '@/lib/byok/test-reasoning';

/**
 * POST /api/user/byok/providers/:providerId/models/:modelId/test-reasoning
 *
 * "Instantly test the model reasoning as I toggle it on" (2026-07-25,
 * explicit ask). Deliberately a SEPARATE endpoint from the sibling
 * .../test route (plain connectivity check, no reasoning forced) — this
 * one specifically forces reasoning on and inspects whether real
 * reasoning content actually came back, a genuinely different question
 * from "did it answer at all".
 *
 * REFACTORED (2026-07-26): the actual test logic now lives in the shared
 * lib/byok/test-reasoning.ts helper so the exact same real check can also
 * run automatically the moment a model is discovered via fetch-models or
 * added manually (see those routes) — this route is now a thin manual
 * trigger over that shared helper.
 *
 * Always responds 200 with `{ status: 'success' | 'no_reasoning' | 'error', ... }`
 * — a model/relay that doesn't expose thinking, or a real upstream
 * failure, are both expected outcomes here, not server errors.
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

  const result = await testModelReasoning({
    modelRowId: modelRow.id,
    modelId: modelRow.modelId,
    provider: { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl },
    apiKey,
    userId: session.user.id,
  });

  return NextResponse.json(result);
});
