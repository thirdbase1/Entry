/**
 * Permanent admin-only diagnostic (2026-07-15): inspects a single chat
 * session's stored byokModelId/requestedModel alongside the owning user's
 * CURRENT live BYOK providers/models, side by side -- built to root-cause
 * "BYOK model not found, disabled, or not owned by the current user"
 * reports without guessing, especially the class of bug where a provider
 * gets deleted/recreated (new row, new id) out from under a chat session
 * that still references the old, now-gone model id.
 *
 * GET ?chatId=... -- admin/bearer only, same dual-auth pattern as
 * admin/errors.ts and admin/db/migrate/route.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

async function isAuthorized(req: NextRequest): Promise<boolean> {
  const bearerOk = isAdminBearerAuthorized(req);
  if (bearerOk) return true;
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return false;
  return featureService.isAdmin(session.user.id);
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const chatId = url.searchParams.get('chatId');
  if (!chatId) return NextResponse.json({ error: 'chatId query param required' }, { status: 400 });

  const chat = await prisma.eveChatSession.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true },
  });
  if (!chat) return NextResponse.json({ error: 'chat not found' }, { status: 404 });

  const [byokModelRow, allUserModels] = await Promise.all([
    chat.byokModelId
      ? prisma.userModelProviderModel.findUnique({
          where: { id: chat.byokModelId },
          select: { id: true, modelId: true, isEnabled: true, providerId: true },
        })
      : null,
    prisma.userModelProviderModel.findMany({
      where: { provider: { userId: chat.userId } },
      select: {
        id: true,
        modelId: true,
        isEnabled: true,
        providerId: true,
        provider: { select: { id: true, label: true, baseUrl: true, compatibility: true } },
      },
    }),
  ]);

  const providerOwner = chat.byokModelId
    ? await prisma.userModelProviderModel.findUnique({
        where: { id: chat.byokModelId },
        select: { provider: { select: { id: true, userId: true, label: true } } },
      })
    : null;

  const sandboxTemplates = await prisma.sandboxTemplate.findMany();

  return NextResponse.json({
    chat,
    sandboxTemplates,
    byokModelRowReferencedByChat: byokModelRow,
    providerOwnerCheck: providerOwner
      ? { providerId: providerOwner.provider.id, providerOwnerUserId: providerOwner.provider.userId, chatOwnerUserId: chat.userId, matches: providerOwner.provider.userId === chat.userId }
      : null,
    allUserModelsNow: allUserModels,
  });
}
