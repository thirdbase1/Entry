/**
 * Custom, app-native version history -- REWORKED 2026-08-05.
 *
 * This used to ride Vercel's Instant Rollback API (record = "stamp
 * whatever Vercel deployment is currently live", revert = call Vercel's
 * rollback endpoint). That stopped being true the day production moved to
 * Pxxl's git-based auto-deploy: there is no "currently live Vercel
 * deployment" anymore, so the old logic would silently stamp/revert
 * against a stale, disconnected system. Reworked to be git-native instead,
 * matching how deploys actually happen now (push to `main` on GitHub ->
 * Pxxl dashboard auto-deploys it):
 *
 * - Each `AppVersion` row now stores a GIT COMMIT SHA (reusing the
 *   existing `vercelDeploymentId` column -- no migration needed, it's
 *   just a sha string in that column now) instead of a Vercel deployment
 *   id. `vercelUrl` similarly now holds the GitHub commit URL.
 * - "isLive" is determined by comparing a version's sha against the
 *   real HEAD of `main` on GitHub (public repo, unauthenticated read,
 *   works with zero secrets configured).
 * - POST { label } still records a version the same way as before --
 *   call this right after a push to `main` lands (see DEPLOY.md / the
 *   sandbox rule file). If no `commitSha` is passed in the body, it looks
 *   up `main`'s current HEAD itself.
 * - POST { revertToId } (one-click revert) needs write access to the repo,
 *   which this route does NOT have by default (no secret shipped here on
 *   purpose). Set a `DEPLOY_GITHUB_TOKEN` env var (a GitHub PAT scoped to
 *   `contents:write` on this repo) in the Pxxl dashboard to enable it. If
 *   that's not configured, revert returns a clear 501 explaining exactly
 *   that, instead of pretending to succeed.
 * - Reverting never rewrites history: it creates a brand-new commit on
 *   `main` whose tree matches the target commit's tree, then fast-forwards
 *   the ref to it -- an honest, append-only "restore to this snapshot"
 *   commit, not a force-push.
 */
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const GITHUB_API = 'https://api.github.com';
const REPO = process.env.DEPLOY_GITHUB_REPO || 'thirdbase1/Entry';
const BRANCH = 'main';

function githubHeaders(token?: string) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function currentMainSha(): Promise<string | null> {
  // Unauthenticated read works fine for a public repo (lower rate limit,
  // but this route is only hit by the admin page + occasional agent calls).
  const token = process.env.DEPLOY_GITHUB_TOKEN;
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/commits/${BRANCH}`, {
    headers: githubHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { sha: string };
  return data.sha || null;
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (isAdminBearerAuthorized(req)) return true;
  const { session } = await getUserSessionFromRequest(req);
  return Boolean(session);
}

export async function GET(req: Request) {
  if (!(await isAuthorized(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const [versions, liveSha] = await Promise.all([
      prisma.appVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      currentMainSha().catch(() => null),
    ]);

    return Response.json({
      liveIdKnown: Boolean(liveSha),
      revertEnabled: Boolean(process.env.DEPLOY_GITHUB_TOKEN),
      versions: versions.map(v => ({
        id: v.id,
        label: v.label,
        createdAt: v.createdAt,
        commitSha: v.vercelDeploymentId,
        commitUrl: v.vercelUrl,
        isLive: liveSha != null && v.vercelDeploymentId === liveSha,
      })),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await isAuthorized(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { label?: string; commitSha?: string; revertToId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    // Branch 1: agent recording a fresh version right after a push to main.
    if (body.label) {
      const sha = body.commitSha || (await currentMainSha());
      if (!sha) return Response.json({ error: 'Could not determine the current HEAD of main.' }, { status: 502 });
      const version = await prisma.appVersion.create({
        data: {
          label: body.label.slice(0, 500),
          vercelDeploymentId: sha,
          vercelUrl: `https://github.com/${REPO}/commit/${sha}`,
        },
      });
      return Response.json({ ok: true, version });
    }

    // Branch 2: user-facing revert -- needs DEPLOY_GITHUB_TOKEN.
    if (body.revertToId) {
      const token = process.env.DEPLOY_GITHUB_TOKEN;
      if (!token) {
        return Response.json(
          {
            error:
              'Revert isn\'t wired up yet. Add a DEPLOY_GITHUB_TOKEN secret (a GitHub personal access token with contents:write on this repo) in the Pxxl dashboard to enable one-click revert. Until then, ask the agent to git-revert and push the target commit.',
          },
          { status: 501 },
        );
      }

      const target = await prisma.appVersion.findUnique({ where: { id: body.revertToId } });
      if (!target) return Response.json({ error: 'Version not found.' }, { status: 404 });

      const liveSha = await currentMainSha();
      if (liveSha === target.vercelDeploymentId) {
        return Response.json({ error: 'That version is already live.' }, { status: 400 });
      }
      if (!liveSha) return Response.json({ error: 'Could not determine the current HEAD of main.' }, { status: 502 });

      // Get the target commit's tree.
      const targetCommitRes = await fetch(`${GITHUB_API}/repos/${REPO}/git/commits/${target.vercelDeploymentId}`, {
        headers: githubHeaders(token),
      });
      if (!targetCommitRes.ok) {
        return Response.json({ error: `Could not read target commit (${targetCommitRes.status}).` }, { status: 502 });
      }
      const targetCommit = (await targetCommitRes.json()) as { tree: { sha: string } };

      // Create a brand-new commit on top of current main, with the target's tree.
      const newCommitRes = await fetch(`${GITHUB_API}/repos/${REPO}/git/commits`, {
        method: 'POST',
        headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Revert to "${target.label}"`,
          tree: targetCommit.tree.sha,
          parents: [liveSha],
        }),
      });
      if (!newCommitRes.ok) {
        const t = await newCommitRes.text();
        return Response.json({ error: `Could not create revert commit (${newCommitRes.status}): ${t.slice(0, 300)}` }, { status: 502 });
      }
      const newCommit = (await newCommitRes.json()) as { sha: string };

      // Fast-forward main to it (never force -- this is always a linear
      // append on top of whatever is live right now).
      const refRes = await fetch(`${GITHUB_API}/repos/${REPO}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
        headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      });
      if (!refRes.ok) {
        const t = await refRes.text();
        return Response.json({ error: `Could not update main ref (${refRes.status}): ${t.slice(0, 300)}` }, { status: 502 });
      }

      // Log the revert itself as a new, honest entry in the same
      // append-only timeline -- never delete or hide history.
      const version = await prisma.appVersion.create({
        data: {
          label: `Reverted to "${target.label}"`,
          vercelDeploymentId: newCommit.sha,
          vercelUrl: `https://github.com/${REPO}/commit/${newCommit.sha}`,
        },
      });
      return Response.json({ ok: true, version, reverted: true });
    }

    return Response.json({ error: 'Provide either label (record) or revertToId (revert).' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
