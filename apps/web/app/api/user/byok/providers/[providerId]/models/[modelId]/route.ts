import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/api-error';

// Either field may be sent (the settings page has two independent
// toggles per model row — "shows in selector" and "Thinking" — each
// PATCHes on its own), but at least one is required.
const ToggleSchema = z
  .object({ isEnabled: z.boolean().optional(), reasoningEnabled: z.boolean().optional() })
  .refine(v => v.isEnabled !== undefined || v.reasoningEnabled !== undefined, {
    message: 'isEnabled or reasoningEnabled is required',
  });

/**
 * PATCH /api/user/byok/providers/:providerId/models/:modelId
 * Toggle a single model's `isEnabled` (shows in the chat model selector)
 * and/or `reasoningEnabled` (manual override of the reasoning-capability
 * heuristic — see reasoning-capability.ts). `modelId` here is the
 * UserModelProviderModel row id, not the provider's own slug.
 */
export const PATCH = withApiErrorHandling(async (
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; modelId: string }> }
) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId, modelId } = await params;
  const body = ToggleSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const data: { isEnabled?: boolean; reasoningEnabled?: boolean } = {};
  if (body.data.isEnabled !== undefined) data.isEnabled = body.data.isEnabled;
  if (body.data.reasoningEnabled !== undefined) data.reasoningEnabled = body.data.reasoningEnabled;

  const result = await prisma.userModelProviderModel.updateMany({
    where: { id: modelId, providerId, provider: { userId: session.user.id } },
    data,
  });
  if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ success: true });
});

/**
 * DELETE /api/user/byok/providers/:providerId/models/:modelId
 * Remove a single model from a provider connection.
 */
export const DELETE = withApiErrorHandling(async (
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; modelId: string }> }
) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId, modelId } = await params;
  const result = await prisma.userModelProviderModel.deleteMany({
    where: { id: modelId, providerId, provider: { userId: session.user.id } },
  });
  if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ success: true });
});
