import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * GET /api/user/settings
 * Returns the current user's settings (receiveCommentEmail, receiveInvitationEmail, receiveMentionEmail).
 * Ported 1:1 from the original's UserSettingsResolver.getSettings.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const settings = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  });

  // Default settings if none exist yet
  const payload = settings?.payload as Record<string, boolean> | null;
  return NextResponse.json({
    receiveCommentEmail: payload?.receiveCommentEmail ?? true,
    receiveInvitationEmail: payload?.receiveInvitationEmail ?? true,
    receiveMentionEmail: payload?.receiveMentionEmail ?? true,
  });
}

/**
 * PATCH /api/user/settings
 * Updates the current user's settings.
 * Ported 1:1 from the original's UserSettingsResolver.updateSettings.
 */
export async function PATCH(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const update: Record<string, boolean> = {};

  if (typeof body.receiveCommentEmail === 'boolean') {
    update.receiveCommentEmail = body.receiveCommentEmail;
  }
  if (typeof body.receiveInvitationEmail === 'boolean') {
    update.receiveInvitationEmail = body.receiveInvitationEmail;
  }
  if (typeof body.receiveMentionEmail === 'boolean') {
    update.receiveMentionEmail = body.receiveMentionEmail;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  // Merge with existing settings
  const existing = await prisma.userSettings.findUnique({
    where: { userId: session.user.id },
  });

  const currentPayload = (existing?.payload as Record<string, boolean>) ?? {
    receiveCommentEmail: true,
    receiveInvitationEmail: true,
    receiveMentionEmail: true,
  };

  await prisma.userSettings.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      payload: { ...currentPayload, ...update },
    },
    update: {
      payload: { ...currentPayload, ...update },
    },
  });

  return NextResponse.json({ success: true });
}
