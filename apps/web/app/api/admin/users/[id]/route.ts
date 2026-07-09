import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest, userModel } from '@entry/auth';
import { prisma } from '@entry/db';
import { featureService } from '@entry/features';

/**
 * PATCH /api/admin/users/[id]
 * Update a user (admin only) — can change email or name.
 * Ported 1:1 from the original's UserManagementResolver.updateUser.
 * (No `role` field exists — admin status is a feature flag, managed via
 * /api/admin/users/[id]/features instead of a role patch here.)
 */
export async function PATCH(
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
  const body = await req.json();

  const update: { email?: string; name?: string } = {};
  if (body.email) update.email = body.email;
  if (body.name) update.name = body.name;

  try {
    const updated = await userModel.updateUser(id, update);
    return NextResponse.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      image: updated.image,
      emailVerified: updated.emailVerified,
      disabled: updated.disabled,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Update failed' }, { status: 400 });
  }
}

/**
 * DELETE /api/admin/users/[id]
 * Delete a user (admin only). Cannot delete own account.
 * Ported 1:1 from the original's UserManagementResolver.deleteUser.
 */
export async function DELETE(
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
  if (id === session.user.id) {
    return NextResponse.json({ error: 'Cannot delete own account' }, { status: 400 });
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
