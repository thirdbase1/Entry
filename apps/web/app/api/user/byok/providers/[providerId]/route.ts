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
  // Lets a user switch an existing connection's API shape at any time
  // (2026-07-15, explicit user request: "in the byok do it so u can
  // change API compatible anytime to the one we support, so I don't
  // always create new byok") -- previously compatibility was only set
  // once at creation (AddProviderForm) and had no PATCH path at all, so
  // pointing an existing connection at a different-shaped endpoint meant
  // deleting it and starting over.
  compatibility: z.enum(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OPENAI_RESPONSES']).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(), // pass a new key to rotate it; omit to leave unchanged
});

/**
 * PATCH /api/user/byok/providers/:providerId
 * Update label / compatibility / base URL / rotate the API key.
 */
export const PATCH = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const owned = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = UpdateProviderSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const { label, compatibility, baseUrl, apiKey } = body.data;

  // Re-normalize the base URL against whichever compatibility ends up
  // effective (new one if provided, otherwise the existing one) so
  // switching to ANTHROPIC auto-appends /v1 the same way the "add
  // provider" form already does, even if baseUrl itself wasn't touched
  // in this PATCH.
  const effectiveCompatibility = compatibility ?? owned.compatibility;
  const shouldRenormalizeBaseUrl = baseUrl !== undefined || compatibility !== undefined;
  const effectiveRawBaseUrl = baseUrl ?? owned.baseUrl;

  const updated = await prisma.userModelProvider.update({
    where: { id: providerId },
    data: {
      ...(label !== undefined ? { label } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      ...(shouldRenormalizeBaseUrl
        ? { baseUrl: normalizeBaseUrl(effectiveCompatibility, effectiveRawBaseUrl) }
        : {}),
      ...(apiKey !== undefined ? { encryptedApiKey: apiKey ? encryptApiKey(apiKey) : null } : {}),
      // Switching compatibility invalidates whatever the previous "fetch
      // models" probe found (different discovery endpoint/response shape
      // entirely) -- clear the stale fetch status so the UI doesn't show a
      // now-meaningless "last fetched"/error from the old mode. Existing
      // model rows are left alone (still valid modelId strings a user may
      // want to keep), just the fetch bookkeeping resets.
      ...(compatibility !== undefined ? { lastFetchedAt: null, lastError: null } : {}),
    },
  });

  return NextResponse.json({
    id: updated.id,
    label: updated.label,
    compatibility: updated.compatibility,
    baseUrl: updated.baseUrl,
    hasApiKey: !!updated.encryptedApiKey,
    lastFetchedAt: updated.lastFetchedAt,
    lastError: updated.lastError,
  });
});
