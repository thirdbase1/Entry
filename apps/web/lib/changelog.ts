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
    title: 'Paste-a-config BYOK import + auto model add + auto-verify',
    items: [
      "Adding a BYOK provider now accepts a pasted config block (Codex CLI's config.toml shape, JSON, or plain key=value) and fills in the label, base URL, and API shape (chat vs. Responses API) for you -- covers aggregators like Fireworks, Portkey, AIHubMix, ZenMux, and aerolink.lat that all hand out this same block.",
      "The model named in a pasted config is now added automatically once you save -- no more retyping it into \"add a model id manually\" right after.",
      "If you pasted an API key too, the newly-added model is now auto-verified with a real test call the moment it's saved, so you see pass/fail immediately instead of a blank untested row.",
    ],
  },
  {
    date: '2026-07-18',
    title: 'Faster first response + safer bash + npm integration',
    items: [
      "Fixed a real time-to-first-token regression: the new working-memory lookup was blocking in front of the model call instead of running alongside the other setup work already in flight -- now overlaps instead of stacking, shaving a full extra database round-trip off every single turn's response time.",
      'bash tool no longer silently drops command output when a command exits non-zero (which is completely normal -- a grep with no match, a failing check, etc, not just crashes) -- you now get the real stdout/stderr back either way, plus a clear explanation on the rarer case a command gets killed for using too much memory.',
      'Fixed long chats getting progressively slower to render while streaming -- a rendering bug was silently causing every message in the whole thread to re-render on every single streamed word instead of just the one being written.',
      'Added npm as a connectable integration (Settings > Integrations, and inline in chat) -- paste your own npm access token the same way you already can for Pxxl/Sendbyte.',
    ],
  },
  {
    date: '2026-07-18',
    title: 'Four more streaming reliability fixes',
    items: [
      "Updated the underlying AI SDK (7.0.28 -> 7.0.31), picking up an upstream fix for compressed response chunks not flushing incrementally in Next.js -- exactly the \"looks like it's not streaming, just appears all at once\" symptom.",
      'Added explicit no-buffering response headers -- some proxies/CDNs silently buffer an entire streamed response before releasing any of it if not told otherwise, which looks identical to "not streaming at all" even though the server sent it incrementally.',
      "Added a heartbeat during long silent tool calls (bash, browser automation can run 30s-2min+ with zero output) -- an idle connection that long is exactly what corporate proxies and mobile carriers commonly kill outright, which read as \"streaming just stopped.\" A lightweight keep-alive now flows during any silent gap.",
      'Fixed a subtle resource-leak in the streaming relay where a fast-arriving reply could spawn a pile of uncancelled internal timers.',
    ],
  },
  {
    date: '2026-07-18',
    title: 'Sandbox saving tightened to every 10 seconds',
    items: [
      "The periodic in-flight save added earlier today (every ~30s during a long-running command) is now every ~10s -- roughly 3x more save points across a full-length command, on top of the per-step saving already in place.",
    ],
  },
  {
    date: '2026-07-18',
    title: 'Fixed the GitHub repo-access card missing GitHub\'s most common error message',
    items: [
      'The "this repo isn\'t accessible yet" detection had a subtle bug: it required an exact double-space pattern that GitHub\'s single most common error for this case ("remote: Repository not found.") doesn\'t actually have, so the one-click card silently failed to appear for it. Fixed the detection and added a couple more real GitHub error variants (bare 403s, "Write access to repository not granted.") to catch this reliably.',
    ],
  },
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
