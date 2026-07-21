import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { buildModelClient } from '@/lib/byok/build-model-client';

/**
 * POST /api/user/byok/providers/:providerId/models/:modelId/test
 * "Test connection" (2026-07-15, explicit settings-page request): fires one
 * minimal real completion at a saved BYOK model — model_id here is the
 * `UserModelProviderModel` row id, same as the sibling PATCH/DELETE route —
 * so a user can verify a connection actually answers before relying on it
 * in chat, right from the model picker on the provider card. Deliberately
 * does NOT require `isEnabled: true` (unlike resolveByokModel) since the
 * whole point is testing a model that may not be toggled on yet.
 *
 * Always responds 200 with `{ success, output? , error? }` — a failed
 * upstream call is an entirely expected outcome here, not a server error,
 * so the frontend can render it inline instead of treating it as a fetch
 * failure. Result is also persisted onto the model row (lastTestedAt/
 * lastTestStatus/lastTestError) so the green/red state survives a reload.
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
  const apiKey = provider.encryptedApiKey ? decryptApiKey(provider.encryptedApiKey) : undefined;

  const model = buildModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelRow.modelId,
    { userId: session.user.id }
  );

  // 20s ceiling -- long enough for a real (if slow) first-token response
  // from most providers, short enough this doesn't hang the settings page
  // if the endpoint is simply unreachable/hanging.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let result: { success: true; output: string } | { success: false; error: string };
  try {
    const { text } = await generateText({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      maxOutputTokens: 16,
      abortSignal: controller.signal,
    });
    result = { success: true, output: text.trim().slice(0, 200) };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    result = { success: false, error: message.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }

  await prisma.userModelProviderModel.update({
    where: { id: modelRow.id },
    data: {
      lastTestedAt: new Date(),
      lastTestStatus: result.success ? 'success' : 'error',
      lastTestError: result.success ? null : result.error,
    },
  });

  return NextResponse.json(result);
});
