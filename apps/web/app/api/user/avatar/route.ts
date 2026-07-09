import { NextRequest, NextResponse } from 'next/server';
import { put, del } from '@vercel/blob';
import { getUserSessionFromRequest, userModel, sessionUser } from '@entry/auth';

/**
 * POST /api/user/avatar
 * Upload an avatar image for the current user.
 * Ported 1:1 from the original's UserResolver.uploadAvatar — uses Vercel
 * Blob (`@vercel/blob`) as the storage provider (replacing the original's
 * `this.storage.put/delete` abstraction), same delete-old-avatar pattern.
 *
 * Accepts multipart form data with an 'avatar' file field.
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get('avatar') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  }

  const u = await userModel.getUser(session.user.id);
  if (!u) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const blob = await put(
    `${u.id}-avatar-${Date.now()}`,
    file,
    { contentType: file.type, access: 'public' }
  );

  if (u.image) {
    await del(u.image).catch(() => {});
  }

  const updated = await userModel.updateUser(u.id, { image: blob.url });
  return NextResponse.json(sessionUser(updated));
}

/**
 * DELETE /api/user/avatar
 * Remove the current user's avatar.
 * Ported 1:1 from the original's UserResolver.removeAvatar.
 */
export async function DELETE(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const u = await userModel.getUser(session.user.id);
  if (!u) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (u.image) {
    await del(u.image).catch(() => {});
  }

  await userModel.updateUser(u.id, { image: undefined });
  return NextResponse.json({ success: true });
}
