'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X, Search, GitBranch, ArrowUpRight } from 'lucide-react';

/**
 * GitHub repo picker modal — "Start with GitHub" flow.
 *
 * Opens from the sidebar, shows all repos the user's `entry-github`
 * installation has access to, and on selection creates a new chat with
 * a pre-seeded first message that tells the agent to clone the repo
 * and set up the project. Uses the existing `?msg=` deep-link path so
 * the chat is created exactly like a normal new chat (same URL update,
 * same sidebar entry, same auto-send).
 *
 * Also includes a "Update repository access →" link to GitHub's
 * installation Configure page. With the Setup URL now set to our
 * callback + "Redirect on update" enabled, GitHub redirects back to
 * `/chats?github_picker=1` after the update, which auto-reopens this
 * modal so the user picks their newly-added repo without any extra
 * clicks.
 */

type Repo = {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  updated_at: string;
  language: string | null;
  default_branch: string;
  description: string | null;
  html_url: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** The GitHub installation ID, used for the "Update repo access" link */
  installationId: string | null;
};

export function GitHubRepoPicker({ open, onClose, installationId }: Props) {
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/github/repos');
      if (res.status === 404) {
        setError('GitHub not connected');
        return;
      }
      if (!res.ok) throw new Error(`Failed to load repos (${res.status})`);
      const data = await res.json();
      setRepos(data.repos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load repos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadRepos();
      // Focus search after a tick
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, loadRepos]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleSelect = (repo: Repo) => {
    setSelected(repo.full_name);
    const msg = `Clone my repo ${repo.full_name} (branch: ${repo.default_branch}) and set up the project so I can start working on it.`;
    onClose();
    router.push(`/chats?msg=${encodeURIComponent(msg)}`);
  };

  const filtered = query
    ? repos.filter(r =>
        r.full_name.toLowerCase().includes(query.toLowerCase()) ||
        (r.description ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : repos;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg rounded-lg border bg-card text-card-foreground shadow-lg flex flex-col max-h-[70vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Start with GitHub</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search repositories..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Loading your repositories...
            </div>
          )}

          {error === 'GitHub not connected' && !loading && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground mb-3">GitHub isn't connected yet.</p>
              <a
                href="/api/integrations/github-oauth/start"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                Connect GitHub →
              </a>
            </div>
          )}

          {error && error !== 'GitHub not connected' && !loading && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {error}
              <button onClick={loadRepos} className="block mx-auto mt-2 text-primary hover:underline text-sm">
                Try again
              </button>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No repositories found.
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="py-1">
              {filtered.map(repo => (
                <button
                  key={repo.full_name}
                  onClick={() => handleSelect(repo)}
                  disabled={selected === repo.full_name}
                  className="w-full text-left px-4 py-2.5 hover:bg-accent transition-colors flex items-center gap-3 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{repo.name}</span>
                      {repo.private && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                          private
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {repo.owner}/{repo.name}
                      {repo.language && <span className="ml-1.5">· {repo.language}</span>}
                    </div>
                    {repo.description && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {repo.description}
                      </div>
                    )}
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer — update repo access link */}
        {installationId && (
          <div className="px-4 py-2.5 border-t flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Don't see a repo?</span>
            <a
              href={`https://github.com/settings/installations/${encodeURIComponent(installationId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              Update repository access →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
