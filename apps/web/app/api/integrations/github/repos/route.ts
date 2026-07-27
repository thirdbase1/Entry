import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { getCredential } from '@entry/agent/lib/credential-vault';
import { prisma } from '@entry/db';

/**
 * GET /api/integrations/github/repos
 *
 * Lists repositories accessible to the user's `entry-github` GitHub App
 * installation. Used by the "Start with GitHub" sidebar picker so users
 * can browse their repos and start a chat with one pre-cloned.
 *
 * Tries the installation-scoped endpoint first
 * (GET /user/installations/{id}/repositories) which only returns repos
 * the app installation has access to — the same list GitHub shows on the
 * "Configure" page. Falls back to GET /user/repos (all repos the token
 * can see) if no installation_id is on file.
 *
 * The token comes from our own credential vault (github-oauth/callback
 * stores it there after the OAuth exchange), NOT from Vercel Connect.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getCredential(session.user.id, 'github');
  if (!token) {
    return NextResponse.json({ error: 'GitHub not connected' }, { status: 404 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { githubInstallationId: true },
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let repos: Array<{
    full_name: string;
    name: string;
    owner: string;
    private: boolean;
    updated_at: string;
    language: string | null;
    default_branch: string;
    description: string | null;
    html_url: string;
  }> = [];

  // Try installation-scoped repos first (shows only repos the app can
  // access — matches what GitHub's Configure page shows).
  if (dbUser?.githubInstallationId) {
    try {
      const res = await fetch(
        `https://api.github.com/user/installations/${dbUser.githubInstallationId}/repositories?per_page=100&sort=updated&direction=desc`,
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        repos = (data.repositories ?? []).map((r: any) => ({
          full_name: r.full_name,
          name: r.name,
          owner: r.owner?.login ?? '',
          private: r.private,
          updated_at: r.updated_at,
          language: r.language,
          default_branch: r.default_branch,
          description: r.description,
          html_url: r.html_url,
        }));
      }
    } catch {
      // Fall through to /user/repos
    }
  }

  // Fallback: list all repos the token can see
  if (repos.length === 0) {
    const res = await fetch(
      'https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc&affiliation=owner,collaborator',
      { headers },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub API returned ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    repos = (data as any[]).map(r => ({
      full_name: r.full_name,
      name: r.name,
      owner: r.owner?.login ?? '',
      private: r.private,
      updated_at: r.updated_at,
      language: r.language,
      default_branch: r.default_branch,
      description: r.description,
      html_url: r.html_url,
    }));
  }

  return NextResponse.json({
    repos,
    githubInstallationId: dbUser?.githubInstallationId ?? null,
  });
});
