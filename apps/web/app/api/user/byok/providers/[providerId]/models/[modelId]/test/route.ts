import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { logError } from '@entry/db/error-log';
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

  // FIXED (2026-07-23, real bug: a decrypt failure here used to throw
  // straight past this route's own try/catch entirely -- unlike
  // resolve-model.ts's identical decryptApiKey() call (the real chat
  // path), which wraps it specifically to turn a raw GCM
  // "Unsupported state or unable to authenticate data" crypto crash into
  // a clear "please re-enter it in Settings" message. This route's own
  // doc comment above says "Always responds 200 with { success, error }"
  // -- but that was never actually true for THIS specific failure mode;
  // an uncaught throw here falls through to withApiErrorHandling's
  // generic 500 JSON instead, which the settings-page UI wasn't written
  // to handle as a per-model test result at all. Same friendly message,
  // same catch shape as resolve-model.ts, and — since this IS a genuine
  // per-provider misconfiguration worth knowing about later, unlike an
  // ordinary upstream 401/timeout — this one specific failure mode also
  // gets logError'd (every other failure below intentionally still does
  // NOT, per this route's original design: a bad key or unreachable
  // relay is an expected, non-server-side problem, but "the ciphertext
  // itself can no longer be decrypted with the currently configured
  // server key" is an actual infra-level issue worth a durable record).
  let apiKey: string | undefined;
  if (provider.encryptedApiKey) {
    try {
      apiKey = decryptApiKey(provider.encryptedApiKey);
    } catch (err) {
      const message = `Your saved API key for "${provider.label}" could not be read (likely re-encrypted with a different server key) — please re-enter it in Settings > Providers.`;
      logError({
        source: 'byok-test-connection-decrypt-failed',
        error: err,
        userId: session.user.id,
        context: { providerId, modelId, providerLabel: provider.label },
      });
      await prisma.userModelProviderModel.update({
        where: { id: modelRow.id },
        data: { lastTestedAt: new Date(), lastTestStatus: 'error', lastTestError: message },
      });
      return NextResponse.json({ success: false, error: message });
    }
  }

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
    // ADDED (2026-07-23, real gap: this route's whole failure branch was
    // previously invisible outside lastTestError on the DB row -- an
    // ordinary "expected" upstream failure (wrong key, unreachable relay,
    // model not found) never hit console/error_logs at all, so diagnosing
    // "I tested it and got an error" after the fact meant either the user
    // pastes the exact text back or it's unrecoverable. Low-noise
    // best-effort record now exists either way -- still 200/non-fatal to
    // the caller, this is purely an observability addition, changes
    // nothing about the response shape or the "expected, not a server
    // error" design this route already had.
    logError({
      source: 'byok-test-connection-failed',
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
      lastTestedAt: new Date(),
      lastTestStatus: result.success ? 'success' : 'error',
      lastTestError: result.success ? null : result.error,
    },
  });

  return NextResponse.json(result);
});
