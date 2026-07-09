import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest, userModel, sessionUser } from '@entry/auth';

/**
 * GET /api/user/profile
 * Returns the current user's profile.
 * Ported 1:1 from the original's UserType resolver (sessionUser shape).
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const u = await userModel.getUser(session.user.id);
  if (!u) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json(sessionUser(u));
}

/**
 * PATCH /api/user/profile
 * Updates the current user's profile (name only, per UpdateUserInput).
 * Ported 1:1 from the original's UserResolver.updateUserProfile —
 * `omitBy(input, isNil)` then no-op if empty, else `userModel.update`.
 */
export async function PATCH(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const update: { name?: string } = {};

  if (typeof body.name === 'string' && body.name.trim()) {
    update.name = body.name.trim();
  }

  if (Object.keys(update).length === 0) {
    // No-op — matches original (returns current user unchanged)
    const u = await userModel.getUser(session.user.id);
    return NextResponse.json(sessionUser(u!));
  }

  const updated = await userModel.updateUser(session.user.id, update);
  return NextResponse.json(sessionUser(updated));
}

/**
 * DELETE /api/user/profile
 * Deletes the current user's account.
 * Ported 1:1 from the original's UserResolver.deleteAccount.
 */
export async function DELETE(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await prisma.user.delete({ where: { id: session.user.id } });
  return NextResponse.json({ success: true });
}
