import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';

/**
 * GET /api/user/byok/providers/:providerId/reveal-key
 *
 * Returns the plaintext API key so the owner can copy it (2026-07-15,
 * explicit request: "so I can click a copy to copy my API key I added").
 * The key is AES-256-GCM at rest (packages/db/src/crypto/byok.ts) — it's
 * always been technically reversible server-side, this route just
 * exposes that on demand instead of never at all. Deliberately
 * request-scoped, not baked into the normal provider list payload: only
 * returned to the provider's own owner, on an explicit user-initiated
 * click, never included in the passive GET /providers response the
 * settings page loads on every visit.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const provider = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!provider.encryptedApiKey) return NextResponse.json({ error: 'No API key set for this provider' }, { status: 404 });

  const apiKey = decryptApiKey(provider.encryptedApiKey);
  return NextResponse.json({ apiKey });
});
