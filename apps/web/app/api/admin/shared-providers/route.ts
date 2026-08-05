import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { isMythosClassModelId, MYTHOS_CLASS_MODEL_IDS as MYTHOS_CLASS_MODEL_IDS_FOR_BULK } from '@entry/db/mythos-guard';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

/**
 * Admin: list every shared (isShared=true) model provider and its models,
 * for the Admin > Providers tab (owner ask 2026-08-05: "a very cool UI on
 * admin so it can enable and disable any shared provider").
 *
 * Same session-gated pattern as /api/admin/users -- browser-reachable via
 * a logged-in admin's own session, no secret shipped to the client.
 * Also accepts the ADMIN_DEBUG_TOKEN bearer for curl/out-of-band use,
 * matching every other session-gated admin route in this file tree.
 *
 * "Enable/disable a shared provider" is implemented as a bulk toggle over
 * every model row under that provider (there is no separate provider-level
 * isEnabled column -- see UserModelProvider in schema.prisma) so it needs
 * no migration: disabling a provider here sets every one of its models'
 * isEnabled to false, which is exactly the flag resolve-model.ts and the
 * chat model selector already gate visibility on. Re-enabling restores
 * every model to enabled. Individual models can still be flipped one at a
 * time from the same payload the UI already has (PATCH below).
 */
async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  if (isAdminBearerAuthorized(req)) return null;
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const providers = await prisma.userModelProvider.findMany({
    where: { isShared: true },
    orderBy: { label: 'asc' },
    select: {
      id: true,
      label: true,
      compatibility: true,
      baseUrl: true,
      spendCapUsd: true,
      lastError: true,
      updatedAt: true,
      models: {
        orderBy: { modelId: 'asc' },
        select: { id: true, modelId: true, label: true, isEnabled: true, reasoningEnabled: true, lastTestStatus: true },
      },
    },
  });

  return NextResponse.json({
    ok: true,
    providers: providers.map(p => ({
      ...p,
      spendCapUsd: p.spendCapUsd === null ? null : Number(p.spendCapUsd),
      modelCount: p.models.length,
      enabledCount: p.models.filter(m => m.isEnabled).length,
    })),
  });
}

/**
 * PATCH body shapes:
 *   { providerId, enabled: boolean }              -> bulk toggle every model under this provider
 *   { providerId, modelRowId, enabled: boolean }   -> toggle a single model row
 */
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { providerId?: string; modelRowId?: string; enabled?: boolean }
    | null;

  if (!body || typeof body.enabled !== 'boolean' || !body.providerId) {
    return NextResponse.json({ error: 'providerId and enabled (boolean) are required' }, { status: 400 });
  }

  const provider = await prisma.userModelProvider.findUnique({
    where: { id: body.providerId },
    select: { id: true, isShared: true },
  });
  if (!provider || !provider.isShared) {
    return NextResponse.json({ error: 'Shared provider not found' }, { status: 404 });
  }

  // MYTHOS GUARD (2026-08-05, real bug found by code audit -- owner
  // standing instruction: "Hide 'Mythos' models entirely from the model
  // picker"). Before this, isEnabled:true here was accepted unconditionally
  // for any row -- nothing stopped an admin (or a future automated re-seed)
  // from flipping a Mythos-class model back on through this exact toggle.
  // See @entry/db/mythos-guard for the single source of truth this now
  // shares with seed-freemodel-provider/route.ts.
  if (body.modelRowId) {
    const targetRow = await prisma.userModelProviderModel.findUnique({
      where: { id: body.modelRowId, providerId: body.providerId },
      select: { modelId: true },
    });
    if (body.enabled && targetRow && isMythosClassModelId(targetRow.modelId)) {
      return NextResponse.json({ error: `${targetRow.modelId} is a Mythos-class model and cannot be enabled in the picker.` }, { status: 400 });
    }
    const updated = await prisma.userModelProviderModel.update({
      where: { id: body.modelRowId, providerId: body.providerId },
      data: { isEnabled: body.enabled },
      select: { id: true, modelId: true, isEnabled: true },
    });
    return NextResponse.json({ ok: true, model: updated });
  }

  // Bulk provider-level toggle: enabling never touches Mythos-class rows
  // under that provider (they silently stay off), disabling still clears
  // everything as before.
  const result = body.enabled
    ? await prisma.userModelProviderModel.updateMany({
        where: { providerId: body.providerId, NOT: { modelId: { in: Array.from(MYTHOS_CLASS_MODEL_IDS_FOR_BULK) } } },
        data: { isEnabled: true },
      })
    : await prisma.userModelProviderModel.updateMany({
        where: { providerId: body.providerId },
        data: { isEnabled: false },
      });
  return NextResponse.json({ ok: true, updatedCount: result.count });
}
