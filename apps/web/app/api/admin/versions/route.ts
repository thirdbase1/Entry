/**
 * Custom, app-native version history (2026-07-16, replaces two earlier,
 * explicitly-rejected attempts: first a raw Vercel-deployment browser
 * (broke on a misconfigured token, "access token not configured"), then
 * a GitHub-commit browser with manual git-revert + "ask your agent to
 * deploy" (rejected: "No not GitHub versioning... our own custom
 * versioning, so when agent do something wrong I can revert to another
 * version").
 *
 * This is the actual custom system: every shipped change gets its own
 * `AppVersion` row (id, plain-language label, timestamp) written by the
 * agent right after a successful production deploy (see DEPLOY.md +
 * POST below). No git shas, no commit messages, no GitHub concepts are
 * ever surfaced to the product. Reverting is fully self-service and
 * instant: each version privately carries the Vercel deployment id that
 * was live when it was created, and "revert" calls Vercel's real Instant
 * Rollback API to repoint production at that already-built artifact --
 * seconds, no rebuild, no agent needed at click time. That's the only
 * mechanism that makes "click revert -> live" literally true, so it's
 * kept as an internal implementation detail rather than reintroducing a
 * rebuild-every-revert flow.
 *
 * CREDENTIAL SOURCE (2026-07-17): this used to read a static personal
 * access token from a `VERCEL_TOKEN_2` env var, which twice went dead
 * (wrong scope, then a stale value) and both times silently broke this
 * whole route until manually caught and re-pasted. Replaced with Vercel
 * Connect (`@vercel/connect`) -- a `vercel/entry-vercel-internal`
 * connector owned by this project, authenticated via this Function's own
 * OIDC identity, no stored long-lived secret at all. `getToken()` mints
 * a short-lived scoped token per call and Vercel handles rotation --
 * this class of "token silently died" bug should no longer be possible
 * here. See @vercel/connect's README for the underlying OIDC exchange.
 *
 * GET  -> version list, newest first, each flagged `isLive` by exact
 *         match against Vercel's current production deployment id
 *         (exact id equality -- no fuzzy sha matching).
 * POST { label } -> agent-only: records a new version pointing at
 *         whatever Vercel deployment is *currently* live production (to
 *         be called immediately after a successful `vercel deploy
 *         --prebuilt --prod`).
 * POST { revertToId } -> user-facing: instantly rolls production back to
 *         that version's Vercel deployment via Instant Rollback, then
 *         records a fresh AppVersion row for the resulting live state so
 *         the timeline stays an honest, append-only log (never mutates
 *         or deletes past rows).
 *
 * Admin-only, single-owner product (see DEPLOY.md) -- any authenticated
 * session on this instance is the owner.
 */
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { getToken } from '@vercel/connect';

const VERCEL_API = 'https://api.vercel.com';
const PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_vwm0Sv2SJz07EcyEu7eGIPblMpLd';
const TEAM_ID = process.env.VERCEL_ORG_ID || 'team_T8HMN4wYS9DoznHfnNiplKJW';
const VERCEL_CONNECTOR = 'vercel/entry-vercel-internal';

// The "vercel" connector is a generic-OAuth connector (Vercel has no
// dedicated managed connector type for itself), set up by a real human
// (the app owner) authorizing it in their own browser -- so its grant is
// bound to that owner's Vercel account, not an app-wide credential.
// Redeeming it therefore needs subject: { type: 'user', id: <owner's
// Vercel account uid> }, not { type: 'app' } (confirmed via the "Token
// unresolved" error returned for the app-subject attempt).
const OWNER_VERCEL_UID = process.env.VERCEL_OWNER_UID || 'X3QHylwBnTGvxQ1jG1LZ4HVe';

async function vercelHeaders() {
  const token = await getToken(VERCEL_CONNECTOR, { subject: { type: 'user', id: OWNER_VERCEL_UID } });
  if (!token) throw new Error(`Vercel Connect returned no token for connector "${VERCEL_CONNECTOR}".`);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function isAuthorized(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization') || '';
  if (Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`) return true;
  const { session } = await getUserSessionFromRequest(req);
  return Boolean(session);
}

async function currentLiveDeploymentId(): Promise<string | null> {
  const res = await fetch(
    `${VERCEL_API}/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&target=production&limit=1&state=READY`,
    { headers: await vercelHeaders(), cache: 'no-store' },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { deployments: Array<{ uid: string }> };
  return data.deployments?.[0]?.uid || null;
}

export async function GET(req: Request) {
  if (!(await isAuthorized(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const [versions, liveId] = await Promise.all([
      prisma.appVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      currentLiveDeploymentId().catch(() => null),
    ]);

    return Response.json({
      liveIdKnown: Boolean(liveId),
      versions: versions.map(v => ({
        id: v.id,
        label: v.label,
        createdAt: v.createdAt,
        isLive: liveId != null && v.vercelDeploymentId === liveId,
      })),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await isAuthorized(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { label?: string; revertToId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    // Branch 1: agent recording a fresh version right after a deploy.
    if (body.label) {
      const liveId = await currentLiveDeploymentId();
      if (!liveId) return Response.json({ error: 'Could not determine the current live deployment.' }, { status: 502 });
      const version = await prisma.appVersion.create({
        data: { label: body.label.slice(0, 500), vercelDeploymentId: liveId },
      });
      return Response.json({ ok: true, version });
    }

    // Branch 2: user-facing instant revert.
    if (body.revertToId) {
      const target = await prisma.appVersion.findUnique({ where: { id: body.revertToId } });
      if (!target) return Response.json({ error: 'Version not found.' }, { status: 404 });

      const liveId = await currentLiveDeploymentId();
      if (liveId === target.vercelDeploymentId) {
        return Response.json({ error: 'That version is already live.' }, { status: 400 });
      }

      const rollbackRes = await fetch(
        `${VERCEL_API}/v9/projects/${PROJECT_ID}/rollback/${target.vercelDeploymentId}?teamId=${TEAM_ID}`,
        { method: 'POST', headers: await vercelHeaders() },
      );
      if (!rollbackRes.ok) {
        const t = await rollbackRes.text();
        return Response.json({ error: `Rollback failed (${rollbackRes.status}): ${t.slice(0, 300)}` }, { status: 502 });
      }

      // Log the revert itself as a new, honest entry in the same
      // append-only timeline -- never delete or hide history.
      const version = await prisma.appVersion.create({
        data: { label: `Reverted to "${target.label}"`, vercelDeploymentId: target.vercelDeploymentId },
      });
      return Response.json({ ok: true, version, reverted: true });
    }

    return Response.json({ error: 'Provide either label (record) or revertToId (revert).' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
