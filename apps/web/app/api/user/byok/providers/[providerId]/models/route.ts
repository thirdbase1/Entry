import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/api-error';
import { logError } from '@entry/db/error-log';
import { autoTestReasoningInBackground } from '@/lib/byok/test-reasoning';

const AddModelSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().optional(),
});

/**
 * POST /api/user/byok/providers/:providerId/models
 * Manually add a single model by id — the fallback when a provider
 * doesn't support (or the user doesn't want to use) the fetch-models
 * discovery call.
 */
export const POST = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const provider = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = AddModelSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const model = await prisma.userModelProviderModel.upsert({
    where: { providerId_modelId: { providerId, modelId: body.data.modelId } },
    create: { providerId, modelId: body.data.modelId, label: body.data.label },
    update: { label: body.data.label },
  });

  // AUTO REASONING TEST (2026-07-26, explicit ask: "when add model id it
  // should test it"). Same fire-and-forget shared helper fetch-models
  // uses -- response returns immediately, the row's lastReasoningTest*
  // columns update in the background once the real check completes.
  if (provider.encryptedApiKey) {
    let apiKey: string | undefined;
    try {
      apiKey = decryptApiKey(provider.encryptedApiKey);
    } catch (err) {
      logError({
        source: 'byok-add-model-auto-test-decrypt-failed',
        error: err,
        userId: session.user.id,
        context: { providerId, modelId: model.modelId, providerLabel: provider.label },
      });
      apiKey = undefined;
    }
    if (apiKey) {
      autoTestReasoningInBackground(
        [{ modelRowId: model.id, modelId: model.modelId }],
        { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl },
        apiKey,
        session.user.id
      );
    }
  }

  return NextResponse.json({
    id: model.id,
    modelId: model.modelId,
    label: model.label,
    isEnabled: model.isEnabled,
    reasoningEnabled: model.reasoningEnabled,
    lastTestedAt: model.lastTestedAt,
    lastTestStatus: model.lastTestStatus,
    lastTestError: model.lastTestError,
  });
});
