import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';

/**
 * POST /api/admin/users/[id]/ban
 * Ban a user (admin only).
 * Ported 1:1 from the original's UserManagementResolver.banUser.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const updated = await prisma.user.update({
    where: { id },
    data: { disabled: true },
    select: { id: true, email: true, name: true, disabled: true },
  });

  return NextResponse.json(updated);
}
