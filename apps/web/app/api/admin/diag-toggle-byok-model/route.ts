/** One-off admin diagnostic (2026-07-22): flip a single BYOK model row's
 * isEnabled flag directly, bypassing the normal session-scoped
 * PATCH /api/user/byok/providers/[id]/models/[id] route (which requires a
 * real browser session, not the admin bearer token used for out-of-band
 * fixes). Used here to kill a duplicate/broken "claude-opus-4-7" entry
 * under the "Freekl" (api.freemodel.dev) BYOK provider that relay doesn't
 * actually support -- a working, separately-added row for the same model
 * name exists under a different provider ("Anthropic", cc.freemodel.dev)
 * and is left untouched. Bearer ADMIN_DEBUG_TOKEN only. */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { modelRowId, isEnabled } = (await req.json()) as { modelRowId?: string; isEnabled?: boolean };
  if (!modelRowId || typeof isEnabled !== 'boolean') {
    return Response.json({ error: 'modelRowId and isEnabled (boolean) required' }, { status: 400 });
  }

  const updated = await prisma.userModelProviderModel.update({
    where: { id: modelRowId },
    data: { isEnabled },
    select: { id: true, modelId: true, isEnabled: true, providerId: true },
  });

  return Response.json({ ok: true, updated });
}
