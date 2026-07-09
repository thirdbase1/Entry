import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';

/**
 * POST /api/user/byok/providers/:providerId/fetch-models
 * The "fetch agent" — calls the provider's own model-listing endpoint
 * (shape depends on compatibility mode) and upserts the results as
 * UserModelProviderModel rows. New models default to enabled; models that
 * already existed keep whatever on/off state the user had set. Never
 * deletes existing rows on a partial/failed fetch — only adds.
 */
async function discoverModels(
  compatibility: 'OPENAI' | 'ANTHROPIC' | 'GOOGLE',
  baseUrl: string,
  apiKey: string | undefined
): Promise<{ modelId: string; label?: string }[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    if (compatibility === 'OPENAI') {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      return list
        .map((m: any) => ({ modelId: typeof m === 'string' ? m : m.id, label: m.name ?? undefined }))
        .filter((m: any) => !!m.modelId);
    }

    if (compatibility === 'ANTHROPIC') {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      return list.map((m: any) => ({ modelId: m.id, label: m.display_name ?? undefined })).filter((m: any) => !!m.modelId);
    }

    // GOOGLE
    const url = new URL(`${baseUrl}/models`);
    if (apiKey) url.searchParams.set('key', apiKey);
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const list = Array.isArray(json?.models) ? json.models : [];
    return list
      .map((m: any) => ({ modelId: (m.name ?? '').replace(/^models\//, ''), label: m.displayName ?? undefined }))
      .filter((m: any) => !!m.modelId);
  } finally {
    clearTimeout(timeout);
  }
}

export const POST = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { providerId } = await params;
  const provider = await prisma.userModelProvider.findFirst({ where: { id: providerId, userId: session.user.id } });
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const apiKey = provider.encryptedApiKey ? decryptApiKey(provider.encryptedApiKey) : undefined;

  try {
    const discovered = await discoverModels(provider.compatibility, provider.baseUrl, apiKey);
    if (discovered.length === 0) {
      throw new Error('The endpoint returned an empty model list — check the base URL and API key.');
    }

    await prisma.$transaction([
      ...discovered.map(m =>
        prisma.userModelProviderModel.upsert({
          where: { providerId_modelId: { providerId, modelId: m.modelId } },
          create: { providerId, modelId: m.modelId, label: m.label },
          // Only refresh the label on re-fetch — never touch isEnabled, so
          // the user's toggle choices survive repeated fetches.
          update: { label: m.label },
        })
      ),
      prisma.userModelProvider.update({ where: { id: providerId }, data: { lastFetchedAt: new Date(), lastError: null } }),
    ]);

    const models = await prisma.userModelProviderModel.findMany({ where: { providerId }, orderBy: { modelId: 'asc' } });
    return NextResponse.json({
      fetched: discovered.length,
      models: models.map(m => ({ id: m.id, modelId: m.modelId, label: m.label, isEnabled: m.isEnabled })),
    });
  } catch (error: any) {
    const message = error?.message ?? 'Failed to fetch models from that base URL.';
    await prisma.userModelProvider.update({ where: { id: providerId }, data: { lastError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
