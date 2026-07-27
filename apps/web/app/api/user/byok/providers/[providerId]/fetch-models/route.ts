import { NextRequest, NextResponse } from 'next/server';
import { prisma, decryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { normalizeBaseUrl } from '@/lib/byok/normalize-base-url';
import { autoTestReasoningInBackground } from '@/lib/byok/test-reasoning';

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
    // DISABLED (owner ask, 2026-07-26): "disable vercel AI gateway model
    // fetching for now" -- keep the AI_GATEWAY compatibility mode itself
    // intact (existing connections/models a user already fetched keep
    // working at chat time, nothing here touches that path), just stop
    // this discovery call from hitting Vercel's Gateway API. Surfaces as
    // a normal fetchError/lastError on the provider row via the catch
    // block below the caller -- same UX as any other discovery failure,
    // not a crash.
    throw new Error(
      'AI Gateway model fetching is temporarily disabled. Add model IDs manually for this connection for now.'
    );
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

    // LABEL-STOMP FIX (2026-07-27, real bug -- owner report: "look the
    // model selector you will see the model that you added something
    // extra to there name, e.g. DeepSeek v4 pro routing to nemotron 3
    // ultra" + "I told you the name should be clean"). Root cause: this
    // upsert unconditionally overwrote `label` from the LIVE provider's
    // own `/models` response on every re-fetch, no exceptions -- and a
    // relay like HCNSec's `api.hcnsec.cn` genuinely returns
    // `display_name: "DeepSeek-V4-Pro (routes to Nemotron 3 Ultra)"` for
    // that alias (it's honest about the mislabeling in its OWN metadata,
    // see seed-shared-provider/route.ts's pricing-methodology comment).
    // seed-shared-provider.ts deliberately writes a clean curated label
    // ("DeepSeek-V4-Pro", no routing text) for exactly this reason -- but
    // since the shared provider row's `userId` is the admin account, it
    // shows up in that account's OWN "Your providers" list too, and one
    // "Fetch models" click there (a perfectly normal, expected action) 
    // re-synced every label straight from the live API and clobbered the
    // clean ones right back to the ugly upstream text. Fix: only ever set
    // `label` from live discovery on a genuinely NEW model row (`create`)
    // -- an already-existing row (curated or previously discovered) keeps
    // whatever label it has; discovery only fills in a label for models
    // that don't have one yet, never overwrites one that does.
    const existingRows = await prisma.userModelProviderModel.findMany({
      where: { providerId },
      select: { modelId: true, label: true },
    });
    const existingLabelByModelId = new Map(existingRows.map(r => [r.modelId, r.label]));

    await prisma.$transaction([
      ...discovered.map(m =>
        prisma.userModelProviderModel.upsert({
          where: { providerId_modelId: { providerId, modelId: m.modelId } },
          create: { providerId, modelId: m.modelId, label: m.label },
          update: existingLabelByModelId.get(m.modelId) ? {} : { label: m.label },
        })
      ),
      prisma.userModelProvider.update({ where: { id: providerId }, data: { lastFetchedAt: new Date(), lastError: null } }),
    ]);

    const models = await prisma.userModelProviderModel.findMany({ where: { providerId }, orderBy: { modelId: 'asc' } });

    // AUTO REASONING TEST (2026-07-26, explicit ask: "when I fetch model
    // it should test all model reasoning"). Fire-and-forget, limited
    // concurrency -- the HTTP response below returns immediately with
    // whatever lastReasoningTest* state each row already had; results
    // land on the rows as the background tests complete (same columns
    // the manual per-model "test reasoning" toggle already writes to),
    // so the settings page picks them up on its next poll/reload without
    // this endpoint's caller needing to wait through however many models
    // just got discovered.
    autoTestReasoningInBackground(
      models.map(m => ({ modelRowId: m.id, modelId: m.modelId })),
      { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl },
      apiKey,
      session.user.id
    );

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
