/**
 * Deployment history + revert (2026-07-14/15, explicit user request:
 * "Agent work versioning... connect it well so user can revert any time
 * to any Vercel [deployment]"). Deliberately a thin wrapper around
 * Vercel's OWN deployment history + Instant Rollback feature rather than
 * a home-grown versioning system — Vercel already builds and retains
 * every deployment as an immutable, independently-addressable artifact;
 * reverting doesn't need a rebuild, it just needs to repoint the
 * production alias at an already-built deployment, which is exactly what
 * Vercel's rollback endpoint does (instant, no downtime, no new build).
 *
 * GET  -> recent production deployments (id, commit message/sha, branch,
 *         state, creator, timestamp, whether it's the current one).
 * POST -> { deploymentId } roll production back to that deployment via
 *         Vercel's Instant Rollback API — POST /v9/projects/{id}/rollback/{deploymentId}.
 *         Confirmed real endpoint (what `vercel rollback` itself calls;
 *         see vercel.com/docs/instant-rollback and
 *         github.com/vercel/vercel/discussions/10833).
 *
 * Admin-only — this changes what's live in production for every visitor,
 * not per-user chat data. Single-owner product (see DEPLOY.md), so any
 * authenticated session on this instance is the owner.
 */
import { getUserSessionFromRequest } from '@entry/auth';

const VERCEL_API = 'https://api.vercel.com';
const PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_vwm0Sv2SJz07EcyEu7eGIPblMpLd';
const TEAM_ID = process.env.VERCEL_ORG_ID || 'team_T8HMN4wYS9DoznHfnNiplKJW';

function vercelHeaders() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN is not configured on the server.');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function isAdmin(req: Request): Promise<boolean> {
  const { session } = await getUserSessionFromRequest(req);
  return Boolean(session);
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const url = `${VERCEL_API}/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&target=production&limit=30`;
    const res = await fetch(url, { headers: vercelHeaders(), cache: 'no-store' });
    if (!res.ok) {
      const body = await res.text();
      return Response.json({ error: `Vercel API error (${res.status}): ${body.slice(0, 300)}` }, { status: 502 });
    }
    const data = (await res.json()) as {
      deployments: Array<{
        uid: string;
        name: string;
        url: string;
        created: number;
        state: string;
        target?: string;
        meta?: Record<string, string>;
        creator?: { username?: string };
      }>;
    };

    const deployments = data.deployments.map((d, idx) => ({
      id: d.uid,
      url: d.url,
      state: d.state,
      createdAt: d.created,
      isCurrent: idx === 0 && d.state === 'READY',
      commitMessage: d.meta?.githubCommitMessage || d.meta?.gitCommitMessage || null,
      commitSha: (d.meta?.githubCommitSha || d.meta?.gitCommitSha || '').slice(0, 7) || null,
      branch: d.meta?.githubCommitRef || d.meta?.gitCommitRef || null,
      creator: d.creator?.username || null,
    }));

    return Response.json({ deployments });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { deploymentId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { deploymentId } = body;
  if (typeof deploymentId !== 'string' || !deploymentId) {
    return Response.json({ error: 'deploymentId is required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${VERCEL_API}/v9/projects/${PROJECT_ID}/rollback/${deploymentId}?teamId=${TEAM_ID}`, {
      method: 'POST',
      headers: vercelHeaders(),
    });
    if (!res.ok) {
      const errBody = await res.text();
      return Response.json({ error: `Vercel rollback failed (${res.status}): ${errBody.slice(0, 300)}` }, { status: 502 });
    }
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
