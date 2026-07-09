import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest, AUTH_PASSWORD_LIMITS } from '@entry/auth';
import { featureService } from '@entry/features';

// Hardcoded app identity — not env vars. Name and version are code decisions
// (bump SERVER_APP_VERSION in a normal commit when you cut a release), not
// per-deployment secrets or infra config.
const SERVER_APP_NAME = 'Entry';
const SERVER_APP_VERSION = '1.0.0';

/**
 * GET /api/server/config
 * Returns server configuration: enabled features, OAuth providers, server name, version.
 * Ported 1:1 from the original's ServerConfigType query.
 *
 * This is a PUBLIC endpoint — no auth required. The original exposed this
 * via a @Public() GraphQL query so the sign-in page can show which OAuth
 * providers are available before the user is authenticated.
 *
 * The Feature model has no `enabled` or `type` column — features are simply
 * rows in the `features` table, identified by `name`. All existing features
 * are "available"; the frontend uses this list to show toggles.
 */
export async function GET(req: NextRequest) {
  const features = await prisma.feature.findMany({
    select: { name: true, configs: true },
  });

  // OAuth providers: we only support Google and GitHub (Apple/OIDC excluded by owner)
  const oauthProviders = [
    { type: 'GitHub', icon: 'github' },
    { type: 'Google', icon: 'google' },
  ];

  // Check if any user has been created (initialized check from ConfigResolver.initialized)
  const userCount = await prisma.user.count();

  return NextResponse.json({
    name: SERVER_APP_NAME,
    version: SERVER_APP_VERSION,
    type: 'AgentServer',
    initialized: userCount > 0,
    // Derived from the incoming request — no APP_BASE_URL env var needed.
    // req.nextUrl.origin already accounts for the proxy/host Vercel puts
    // the request behind, so this is correct in prod, preview, and local dev.
    baseUrl: req.nextUrl.origin,
    features: features.map(f => f.name),
    availableUserFeatures: features.map(f => f.name),
    oauthProviders,
    credentialsRequirement: {
      // Single source of truth shared with packages/auth/src/auth.ts —
      // previously this route hardcoded its own copy (8/32) independently
      // from the auth.ts env-var-driven values, which could silently drift.
      password: AUTH_PASSWORD_LIMITS,
    },
  });
}

/**
 * PUT /api/server/config
 * Update the app configuration (admin only).
 * Ported 1:1 from ConfigResolver.updateAppConfig.
 *
 * Body: { updates: Array<{ key: string; value: any }> }
 * Requires admin authentication.
 *
 * The Feature model has no `enabled`/`type`/`description` fields — features
 * are toggled per-user via UserFeature rows (see featureService). This
 * endpoint is kept for config key-value updates that aren't feature toggles.
 */
export async function PUT(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isAdmin = await featureService.isAdmin(session.user.id);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  const body = await req.json();
  const { updates } = body;

  if (!Array.isArray(updates)) {
    return NextResponse.json({ error: 'updates must be an array' }, { status: 400 });
  }

  // Store config key-value pairs as AppConfig entries
  const results: Record<string, unknown> = {};
  for (const { key, value } of updates) {
    if (typeof key !== 'string') continue;
    await prisma.appConfig.upsert({
      where: { id: key },
      update: { value: value as any },
      create: { id: key, value: value as any },
    }).catch(() => {});
    results[key] = value;
  }

  return NextResponse.json(results);
}
