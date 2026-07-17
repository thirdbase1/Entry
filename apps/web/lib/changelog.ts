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
