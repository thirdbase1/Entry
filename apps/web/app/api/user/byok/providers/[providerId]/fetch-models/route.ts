import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { normalizeBaseUrl } from '@/lib/byok/normalize-base-url';
import { createGateway } from '@ai-sdk/gateway';

/**
 * POST /api/user/byok/providers/:providerId/fetch-models
 * The "fetch agent" — calls the provider's own model-listing endpoint
 * (shape depends on compatibility mode) and upserts the results as
 * UserModelProviderModel rows. New models default to enabled; models that
 * already existed keep whatever on/off state the user had set. Never
 * deletes existing rows on a partial/failed fetch — only adds.
 */
async function discoverModels(
  compatibility: 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'OPENAI_RESPONSES' | 'AI_GATEWAY',
  baseUrl: string,
  apiKey: string | undefined
): Promise<{ modelId: string; label?: string }[]> {
  // ADDED (2026-07-23, AI Gateway BYOK mode): unlike every other branch
  // below (a plain REST call to the connection's own baseUrl), this asks
  // the AI SDK's own Gateway client for the user's live, personal catalog
  // -- built from THEIR apiKey, not our shared AI_GATEWAY_API_KEY, so a
  // user only ever sees + can use models their own Gateway account
  // actually has access to. This is also why AI_GATEWAY BYOK support
  // never needs a code change for a new model release (e.g. Ling 3.0
  // Flash the day Vercel ships it) -- "fetch models" always reflects
  // whatever the live catalog currently has, same mechanism
  // /api/server/models already uses for the app's own shared catalog.
  if (compatibility === 'AI_GATEWAY') {
    const { models } = await createGateway({ apiKey }).getAvailableModels();
    return models
      .filter(m => m.modelType === 'language' || !m.modelType)
      .map(m => ({ modelId: m.id, label: m.name || undefined }));
  }

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

    if (compatibility === 'OPENAI_RESPONSES') {
      // Same Bearer-auth + `{ data: [...] }` shape as the official OpenAI
      // `GET /v1/models` when a Responses-API endpoint happens to expose
      // one. Aggregators proxying single model families behind a fixed
      // path (Kie.ai's `/grok/v1`, `/gpt/v1`, etc.) commonly don't -- that's
      // fine, it just surfaces the usual fetchError below and the user
      // falls back to "+ add a model id manually" (e.g. `grok-4-5`), same
      // as any other endpoint without discovery support.
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

  // Self-heal older provider rows saved before normalizeBaseUrl() existed
  // (2026-07-11) — e.g. an ANTHROPIC-compatibility row whose baseUrl is
  // just the origin, missing `/v1`. Confirmed real bug: the settings
  // page's AutoSaveField only calls PATCH when the typed value actually
  // *differs* from what's already saved (see its `commit()` guard), so
  // telling a user to "just hit save again" on an unchanged field is a
  // no-op that never reaches the server at all — the only way to fix an
  // already-broken row was editing the text to something different first.
  // Doing the normalize-and-persist right here instead means the one
  // button a user actually has for this ("Fetch models") is what fixes
  // it, with no reliance on re-triggering a save.
  const normalizedBaseUrl = normalizeBaseUrl(provider.compatibility, provider.baseUrl);
  if (normalizedBaseUrl !== provider.baseUrl) {
    await prisma.userModelProvider.update({ where: { id: providerId }, data: { baseUrl: normalizedBaseUrl } });
    provider.baseUrl = normalizedBaseUrl;
  }

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
      models: models.map(m => ({
        id: m.id,
        modelId: m.modelId,
        label: m.label,
        isEnabled: m.isEnabled,
        reasoningEnabled: m.reasoningEnabled,
        lastTestedAt: m.lastTestedAt,
        lastTestStatus: m.lastTestStatus,
        lastTestError: m.lastTestError,
      })),
    });
  } catch (error: any) {
    const message = error?.message ?? 'Failed to fetch models from that base URL.';
    await prisma.userModelProvider.update({ where: { id: providerId }, data: { lastError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
