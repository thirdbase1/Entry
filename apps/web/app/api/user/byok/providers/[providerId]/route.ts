import { NextRequest, NextResponse } from 'next/server';
import { prisma, encryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { normalizeBaseUrl } from '@/lib/byok/normalize-base-url';

/**
 * DELETE /api/user/byok/providers/:providerId
 * Removes a provider connection and all its models (cascade).
 */
export const DELETE = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const result = await prisma.userModelProvider.deleteMany({
    where: { id: providerId, userId: session.user.id },
  });
  if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ success: true });
});

const UpdateProviderSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(), // pass a new key to rotate it; omit to leave unchanged
});

/**
 * PATCH /api/user/byok/providers/:providerId
 * Update label / base URL / rotate the API key.
 */
export const PATCH = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const owned = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = UpdateProviderSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const { label, baseUrl, apiKey } = body.data;
  const updated = await prisma.userModelProvider.update({
    where: { id: providerId },
    data: {
      ...(label !== undefined ? { label } : {}),
      ...(baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(owned.compatibility, baseUrl) } : {}),
      ...(apiKey !== undefined ? { encryptedApiKey: apiKey ? encryptApiKey(apiKey) : null } : {}),
    },
  });

  return NextResponse.json({
    id: updated.id,
    label: updated.label,
    compatibility: updated.compatibility,
    baseUrl: updated.baseUrl,
    hasApiKey: !!updated.encryptedApiKey,
  });
});
