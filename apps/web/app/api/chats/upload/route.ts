import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * POST /api/chats/upload
 * Uploads an image attached to a chat message (the prompt input's new
 * image/photo button, 2026-07-11 -- explicit user request: "many models
 * support that... the + in the prompt input support that?"). Shared by
 * both chat surfaces (the BYOK/Gateway direct-chat path and eve's own
 * chat path) since both ultimately just need a public URL to hand the
 * model as an image/file content part.
 *
 * Same storage provider as /api/user/avatar (@vercel/blob) -- already
 * proven working in this production deployment, no new infra needed.
 *
 * Deliberately image-only for now (this is what the prompt input's file
 * picker restricts to via accept="image/*" -- most BYOK/Gateway vision
 * models only accept images, not arbitrary files). A 10MB cap keeps a
 * single accidental full-resolution photo from stalling the upload or
 * blowing well past what any vision model's own per-image limit accepts
 * anyway.
 */
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get('file') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'Only image files are supported' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Image is too large (10MB max)' }, { status: 400 });
  }

  const blob = await put(`chat-uploads/${session.user.id}-${Date.now()}-${file.name}`, file, {
    contentType: file.type,
    access: 'public',
  });

  return NextResponse.json({ url: blob.url, mediaType: file.type, filename: file.name });
}
