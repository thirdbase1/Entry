/**
 * App-wide changelog (2026-07-17). Plain data, no DB table -- this is a
 * short, hand-curated log of real fixes/features (not auto-generated from
 * commits, which would be far too noisy/internal for a public page).
 * Update this array whenever a real user-facing fix or feature ships.
 * Newest entry first.
 */
export interface ChangelogEntry {
  date: string; // YYYY-MM-DD
  title: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-07-18',
    title: 'One-click GitHub repo access, right from chat',
    items: [
      "If the agent hits a push that fails because this specific repo isn't in Entry's GitHub access list yet, chat now shows a one-click \"Manage repo access\" card instead of telling you to go dig through GitHub's own Settings pages manually.",
      "Fixed GitHub Connect skipping the actual repo-picker screen entirely -- connecting now goes through GitHub's real \"Install & Authorize\" flow, so you actually get to choose which repos Entry can access (or all of them) instead of only authorizing an account with no repo access at all.",
    ],
  },
  {
    date: '2026-07-18',
    title: 'Sandbox saving made far more frequent',
    items: [
      'File-change saving used to happen once, only after a whole reply finished. It now saves incrementally after every step of a reply, plus periodically (every ~30s) DURING any single long-running command -- so a big build/install/pipeline that gets cut off mid-way no longer loses everything back to the start.',
    ],
  },
  {
    date: '2026-07-18',
    title: 'Fixed GitHub Connect using the wrong account for some users',
    items: [
      "GitHub connections were silently resolving to whichever GitHub account first installed the app, not necessarily the account each person actually connected. Token requests now correctly resolve and use each person's own GitHub App installation.",
    ],
  },
  {
    date: '2026-07-18',
    title: 'Fixed sandboxes losing work after sitting idle',
    items: [
      "Found and fixed the real cause of reports that a chat's sandbox lost work: idle sandboxes were being fully deleted after a few minutes of inactivity instead of paused. They're now paused (a complete, durable snapshot of the filesystem) and automatically resumed exactly where you left off -- including if you come back to a live preview link after stepping away.",
    ],
  },
  {
    date: '2026-07-18',
    title: 'The agent now remembers things about you across chats',
    items: [
      "Added durable per-user memory -- the agent can save a short, standing note about you (name spelling, preferences, ongoing projects/goals) and it's automatically shown to it at the start of every future conversation, not just recalled within one session. Works on both the default agent and any BYOK/custom model you pick.",
      "The agent now proactively saves things worth remembering when you share them, instead of only doing it if explicitly asked.",
    ],
  },
  {
    date: '2026-07-17',
    title: 'Fixed the versioning system tracking the Vercel CLI\'s own cache files as project changes',
    items: [
      'A version card could show files like ".cache/com.vercel.cli/..." and ".local/share/com.vercel.cli/..." with a Revert button -- that\'s the Vercel CLI\'s own global state, not anything you or the agent changed in your project. Now excluded, including cleaning up any of it already being tracked from before this fix.',
    ],
  },
  {
    date: '2026-07-17',
    title: "Fixed the Files tab dumping ~3000 sandbox junk files in a brand new chat",
    items: [
      "A new chat's Files tab was showing the sandbox's own pre-loaded tooling cache (npm cache, Playwright browsers, shell rc files, etc.) instead of an empty project -- capped at 3000 entries, which is exactly what was showing up. Now excluded by name so only real project files ever appear.",
    ],
  },
  {
    date: '2026-07-17',
    title: 'Real GitHub/Vercel/Supabase OAuth, and the agent now actually uses it',
    items: [
      'Connect GitHub, Vercel, or Supabase in Settings > Integrations with one click -- a real OAuth grant, no personal token needed. Verified live end-to-end for all three, including a full Supabase sign-in handoff.',
      'Fixed the AI agent asking you to paste a token (or run a CLI login) for a deploy check/action even after you had already connected that account -- it was only checking for a manually pasted token and never tried your real Connect grant. It now always tries your actual connection first.',
    ],
  },
  {
    date: '2026-07-17',
    title: 'Fixed broken redirect URLs across the app',
    items: [
      'Fixed "Connect" (GitHub/Vercel/Supabase) buttons in Settings erroring instead of redirecting to sign-in.',
      'Fixed the automatic chat-recovery check that runs on stuck/mid-flight replies -- it was silently failing every time.',
    ],
  },
  {
    date: '2026-07-17',
    title: 'Streaming, versioning, and cleanup',
    items: [
      'Real-time reply auto-scroll now tracks fast-streaming text smoothly on every chat, including images/screenshots that load in mid-reply.',
      'Added a "thinking…" indicator to the default chat while waiting on the first bit of a reply.',
      'Revert now shows exactly what it will change before you confirm it, and reverts can themselves be undone in one tap.',
      'History search now also matches file paths, not just summaries.',
      'Removed the standalone Terminal tab from the chat panel.',
    ],
  },
  {
    date: '2026-07-17',
    title: 'Fixed GitHub Connect push permissions',
    items: [
      'Fixed \'git push\' via a connected GitHub account failing with a misleading 403 even when the account had write access -- the git URL now uses the required "x-access-token" username for GitHub App tokens instead of the token alone.',
      'Fixed newly-connected GitHub accounts ending up as identity-only (sign-in only, no actual repo access) -- connecting GitHub now requests the app-installation step (repo picker + write permission) up front.',
      'If you connected GitHub before this fix, reconnect it once from Settings > Integrations to pick up real repo write access.',
    ],
  },
  {
    date: '2026-07-17',
    title: 'History & revert improvements',
    items: [
      'Single-file revert -- roll back just one changed file instead of a whole version.',
      'Rename any version with a custom label.',
      'Search chat history by summary or version number.',
      'Download a version\'s full file snapshot as a .tar.gz.',
    ],
  },
  {
    date: '2026-07-17',
    title: 'Reliability fixes',
    items: [
      'Fixed a bug where Kie.ai/Grok-relayed chats could stop instantly after a tool call.',
      'Removed a fraudulent third-party model relay that silently degraded responses under load.',
      'Migrated the agent sandbox off Vercel\'s Hobby-plan limits onto E2B, fixing browser-use and long-running tool calls in production.',
    ],
  },
  {
    date: '2026-07-16',
    title: 'BYOK improvements',
    items: [
      'Added a "Verify Connection" button so you can test a BYOK provider\'s credentials and model list immediately after saving.',
      'Added support for Kie.ai-style "OpenAI Responses API" compatibility mode (used by Grok 4.5 and similar relays).',
    ],
  },
  {
    date: '2026-07-16',
    title: 'Security hardening',
    items: [
      'Removed all plaintext credential files from the dev sandbox in favor of memory-only, ephemeral credential injection.',
      'Production secrets now live exclusively in Vercel\'s encrypted environment store.',
    ],
  },
];
