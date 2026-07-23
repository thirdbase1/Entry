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

  // Fixed (2026-07-23, real false-negative confirmed live): a 20s abort
  // + 16-token output cap looked generous for a plain one-word reply, but
  // several real BYOK relays (confirmed: an OPENAI_RESPONSES-compatible
  // "gpt-5.6-sol" endpoint) are reasoning models that burn hundreds of
  // output tokens on hidden reasoning before ever emitting the visible
  // word -- those reasoning tokens count against BOTH the 16-token cap
  // (truncating before the real answer ever appears) and the wall-clock
  // 20s abort (a same-model diagnostic call with no cap took 18.36s just
  // for "pong"). Net effect: a model that answers fine in real chat
  // (route.ts's actual streamText call allows chunkMs: 90_000 / stepMs:
  // 240_000 -- see that file) failed here with a bare "This operation was
  // aborted", which then persisted as a misleading red "test failed"
  // state on the provider card indefinitely. Raised to line up with what
  // real chat can actually tolerate: still well short of production's
  // 90s/240s (this is a manual, synchronous settings-page click, so it
  // still needs a sane ceiling), but enough headroom for a legitimately
  // slow reasoning relay to finish a one-word reply.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let result: { success: true; output: string } | { success: false; error: string };
  try {
    const { text } = await generateText({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      maxOutputTokens: 300,
      abortSignal: controller.signal,
    });
    result = { success: true, output: text.trim().slice(0, 200) };
  } catch (err: any) {
    // Give the abort case its own clear message -- the raw AbortError
    // text ("This operation was aborted") gives a user zero signal on
    // WHY, and used to read exactly like a hard connection failure
    // instead of "this model is just slow."
    const message = controller.signal.aborted
      ? `No response within 60s -- this model may be slow (reasoning models can take a while) or unreachable. It may still work fine in normal chat, which allows much longer.`
      : (err?.message ?? String(err));
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
