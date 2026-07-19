/**
 * Per-chat version history (2026-07-16). See ChatVersion/ChatVersionFile's
 * schema comments for the full "why" -- short version: the user explicitly
 * rejected both a git/GitHub-based history and a raw Vercel-deployment
 * history, and asked for "our own internal versioning system": every time
 * the agent modifies >=1 file, snapshot it; show a minimal card ("Version
 * #24 · Just now · 12 files changed · +184 -57"); tapping it opens a
 * per-file line-by-line diff; the only action is an instant, one-click
 * Revert (no Compare button -- a version already IS a single snapshot).
 *
 * REWRITTEN (2026-07-16, real bug: "no matter the tool it use to change
 * something in file... the card should show instantly"): the original
 * design only ever detected changes made through the three dedicated
 * file tools (write_file/edit_file/append_file), because that was the
 * only place `recordFileChange` was ever called from. Any file mutation
 * the agent made via `bash` directly (rm, sed -i, mv, redirects, a build
 * step writing generated files, etc -- all extremely common) was
 * completely invisible to versioning. Instrumenting every current AND
 * future tool one-by-one doesn't scale and will always miss the next
 * one someone adds.
 *
 * Fix: stop trying to catch every mutation at the tool layer. Instead,
 * `captureVersionFromSandboxDiff()` diffs the sandbox's OWN real
 * filesystem state against a git baseline committed at the end of the
 * previous turn -- this sees literally every change, regardless of which
 * tool (or combination of tools) produced it, because it's reading the
 * actual disk, not instrumenting the code path that wrote to it. Called
 * once per turn, right when the agent stops:
 *   - eve-default path: apps/agent/agent/hooks/version-capture.ts, a
 *     `turn.completed` stream-event hook (fires the instant eve accepts
 *     that event -- see that file's own comment for why a hook and not
 *     a hand-rolled hop through `after()`).
 *   - direct/BYOK path: apps/web/app/api/direct/chat/route.ts's own
 *     `onFinish`, same as before.
 * `recordFileChange`/`flushPendingVersion` (the original manual
 * per-tool-call buffer) are kept, unchanged, ONLY for the revert route
 * (apps/web/app/api/chats/[sessionId]/versions/[versionNumber]/revert/
 * route.ts) -- a revert already knows exactly which paths it wrote/
 * deleted and their exact new content, so there's nothing to diff there
 * and no reason to pay a git round-trip for it.
 */
import * as Diff from 'diff';
import { prisma } from './db.js';

type ChangeType = 'added' | 'modified' | 'deleted';

interface PendingChange {
  path: string;
  changeType: ChangeType;
  content: string | null; // null for a delete
}

// In-memory per-chat buffer. Safe within a single serverless invocation's
// lifetime (one Node process handles one turn's full tool-calling loop
// start to finish) -- see file comment. Keyed by chatId so concurrent
// turns on different chats in the same warm process never collide.
const pendingByChat = new Map<string, Map<string, PendingChange>>();

/** Called from sandbox-file-io.ts right after a write/append/delete
 *  actually succeeds against the sandbox. Last write for a given path
 *  within one turn wins (Map keyed by path) -- a version reflects the NET
 *  change over the whole turn, not every intermediate edit. Only used by
 *  the revert route now -- see file comment. */
export function recordFileChange(chatId: string, path: string, changeType: ChangeType, content: string | null): void {
  let bucket = pendingByChat.get(chatId);
  if (!bucket) {
    bucket = new Map();
    pendingByChat.set(chatId, bucket);
  }
  bucket.set(path, { path, changeType, content });
}

/** True the FIRST time a file changes within the current turn's buffer
 *  for this chat -- used by the caller to know whether it still needs to
 *  register an `after()` flush for this turn (only needs to happen once).
 *  Only used by the revert route now -- see file comment. */
export function isFirstPendingChangeForChat(chatId: string): boolean {
  const bucket = pendingByChat.get(chatId);
  return !bucket || bucket.size === 0;
}

function diffStats(before: string | null, after: string | null): { linesAdded: number; linesRemoved: number } {
  if (before == null && after == null) return { linesAdded: 0, linesRemoved: 0 };
  if (before == null) return { linesAdded: (after ?? '').split('\n').length, linesRemoved: 0 };
  if (after == null) return { linesAdded: 0, linesRemoved: before.split('\n').length };
  const parts = Diff.diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lineCount = part.value.endsWith('\n') ? part.value.split('\n').length - 1 : part.value.split('\n').length;
    if (part.added) added += lineCount;
    else if (part.removed) removed += lineCount;
  }
  return { linesAdded: added, linesRemoved: removed };
}

function summarize(changes: PendingChange[]): string {
  const added = changes.filter(c => c.changeType === 'added');
  const modified = changes.filter(c => c.changeType === 'modified');
  const deleted = changes.filter(c => c.changeType === 'deleted');
  const basename = (p: string) => p.split('/').pop() || p;

  if (changes.length <= 4) {
    const parts: string[] = [];
    if (added.length) parts.push(`Added ${added.map(c => basename(c.path)).join(', ')}`);
    if (modified.length) parts.push(`Updated ${modified.map(c => basename(c.path)).join(', ')}`);
    if (deleted.length) parts.push(`Deleted ${deleted.map(c => basename(c.path)).join(', ')}`);
    return parts.join(' · ');
  }

  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} added`);
  if (modified.length) parts.push(`${modified.length} updated`);
  if (deleted.length) parts.push(`${deleted.length} deleted`);
  return `${changes.length} files changed (${parts.join(', ')})`;
}

/** Finds what this path's content was immediately before the current
 *  turn, i.e. the `content` of the highest versionNumber < the new one
 *  being created for this chatId+path. Null if never tracked before (a
 *  genuinely new file) or if its last tracked state was itself 'deleted'. */
async function findPreviousContent(chatId: string, path: string): Promise<string | null> {
  const prior = await prisma.chatVersionFile.findFirst({
    where: { chatId, path },
    orderBy: { versionNumber: 'desc' },
  });
  if (!prior || prior.changeType === 'deleted') return null;
  return prior.content;
}

/**
 * Shared core: writes one buffered set of changes as a single new
 * ChatVersion (+ its ChatVersionFile rows), if there are any. Used by
 * both `flushPendingVersion` (manual per-tool buffer, revert route only)
 * and `captureVersionFromSandboxDiff` (git-diff based, every normal
 * turn) -- same schema, same card-append behavior, only the source of
 * `changes` differs.
 */
async function writeVersionRows(
  chatId: string,
  changes: PendingChange[],
  opts: { revertedFromVersionNumber?: number; summaryOverride?: string },
): Promise<{ versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number } | null> {
  if (changes.length === 0) return null;

  let totalAdded = 0;
  let totalRemoved = 0;
  const fileRows: Array<{ path: string; changeType: ChangeType; content: string | null; linesAdded: number; linesRemoved: number }> = [];

  for (const change of changes) {
    const before = await findPreviousContent(chatId, change.path);
    const { linesAdded, linesRemoved } = diffStats(before, change.content);
    totalAdded += linesAdded;
    totalRemoved += linesRemoved;
    fileRows.push({ path: change.path, changeType: change.changeType, content: change.content, linesAdded, linesRemoved });
  }

  const summary = opts.summaryOverride ?? summarize(changes);

  const result = await prisma.$transaction(async tx => {
    const last = await tx.chatVersion.findFirst({ where: { chatId }, orderBy: { versionNumber: 'desc' } });
    const versionNumber = (last?.versionNumber ?? 0) + 1;

    const version = await tx.chatVersion.create({
      data: {
        chatId,
        versionNumber,
        summary,
        filesChanged: fileRows.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        revertedFromVersionNumber: opts.revertedFromVersionNumber ?? null,
      },
    });

    await tx.chatVersionFile.createMany({
      data: fileRows.map(f => ({
        chatId,
        versionId: version.id,
        versionNumber,
        path: f.path,
        changeType: f.changeType,
        content: f.content,
        linesAdded: f.linesAdded,
        linesRemoved: f.linesRemoved,
      })),
    });

    return version;
  });

  const info = { versionNumber: result.versionNumber, summary, filesChanged: fileRows.length, linesAdded: totalAdded, linesRemoved: totalRemoved, revertedFromVersionNumber: opts.revertedFromVersionNumber };
  await appendVersionCardMessage(chatId, info);
  return info;
}

/**
 * Writes the buffered changes for one chat as a single new ChatVersion,
 * if there are any. Safe to call multiple times (e.g. a defensive extra
 * `after()` registration) -- it's a no-op once the buffer for that chat
 * is empty. Returns the created version's summary info, or null if there
 * was nothing to record. Only used by the revert route now -- see file
 * comment.
 */
export async function flushPendingVersion(
  chatId: string,
  opts: { revertedFromVersionNumber?: number; summaryOverride?: string } = {},
): Promise<{ versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number } | null> {
  const bucket = pendingByChat.get(chatId);
  if (!bucket || bucket.size === 0) return null;
  const changes = Array.from(bucket.values());
  pendingByChat.delete(chatId);
  return writeVersionRows(chatId, changes, opts);
}

/**
 * Minimal shape both eve's `SandboxSession` and the direct/BYOK path's
 * `DirectChatSandbox` already satisfy -- see chat-versioning.ts callers
 * (apps/agent/agent/hooks/version-capture.ts and
 * apps/web/app/api/direct/chat/route.ts) for which concrete type each
 * passes in. Only `run` is needed here.
 */
export interface VersionCaptureSandbox {
  run(opts: { command: string }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

// (2026-07-17, user-reported: a version card showing 5 files changed
// that were all Vercel CLI's OWN state -- .cache/com.vercel.cli/...,
// .local/share/com.vercel.cli/... -- with a live Revert button on them).
// Root cause: whenever the agent runs the `vercel` CLI inside a chat's
// sandbox (which is routine -- building/deploying Entry itself, or any
// project the user asks it to deploy), the CLI writes its OWN global
// state under XDG dirs that default to right under the sandbox's home/
// cwd: $XDG_CACHE_HOME (~/.cache/com.vercel.cli) and $XDG_DATA_HOME
// (~/.local/share/com.vercel.cli), plus `.vercel/` (the project-link
// dir vercel CLI writes into cwd directly). None of those were ever in
// this list -- `.cache/` WAS already ignored, but `.local/` and
// `.vercel/` never were, so they got git-added, diffed, and versioned
// like real project edits every single time the CLI ran.
const GIT_IGNORE_CONTENTS = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  '.turbo/',
  '__pycache__/',
  '*.pyc',
  '.venv/',
  'venv/',
  '.cache/',
  '.git/',
  // CLI/tooling global state that can land directly in cwd when it
  // doubles as $HOME -- never actual project files. Kept in sync with
  // list_files.ts's own EXCLUDED list (same root cause, different
  // consumer) -- see that file's comment.
  '.vercel/',
  '.local/',
  '.config/',
  '.npm/',
  '.cargo/',
  '.rustup/',
  '.nvm/',
  '.pyenv/',
  '.agent-browser/',
  'browsers/',
  '_cacache/',
  '_logs/',
  '_update-notifier-last-checked',
  '.bashrc',
  '.bash_logout',
  '.bash_history',
  '.profile',
  '.sudo_as_admin_successful',
  '.wget-hsts',
  '.lesshst',
  '.viminfo',
  '.ssh/',
  '.gnupg/',
  '',
].join('\n');

// Matches GIT_IGNORE_CONTENTS' own directory entries (the trailing `/`
// ones) -- used to actively `git rm --cached` anything that matched an
// OLDER, shorter ignore list and got tracked/committed before this fix,
// since .gitignore alone never retroactively untracks an already-
// committed path. Kept separate from the raw .gitignore text (which also
// has file-pattern lines like `*.pyc` that `git rm -r --cached` can't
// take a bare pattern for the same way) rather than re-parsing it.
const IGNORED_DIR_NAMES = [
  '.vercel', '.local', '.config', '.npm', '.cargo', '.rustup', '.nvm', '.pyenv',
  '.agent-browser', 'browsers', '_cacache', '_logs', '.cache', '.ssh', '.gnupg',
];

/**
 * PER-CHAT SERIALIZATION + LOCK-RETRY (2026-07-19, real bug reported from
 * production logs: `captureVersionFromSandboxDiff failed ... fatal:
 * Unable to create '/home/user/.git/index.lock': File exists. Another git
 * process seems to be running in this repository`). Root cause: this
 * function now fires far more often per turn than it used to (broadened
 * to `step.completed`/`step.failed` on 2026-07-18, see version-capture.ts),
 * AND a duplicate/overlapping request for the SAME chat (a double-submit,
 * a client retry, a reload racing an in-flight turn) can trigger a second,
 * fully independent call against the exact same sandbox's git repo at the
 * exact same time -- two concurrent `git add -A`/`git commit` sequences
 * fighting over the one `.git/index.lock` file. Two-part fix:
 *
 *   1. `chainByChat`: a plain in-process promise queue keyed by chatId --
 *      every call for the same chat now runs strictly after the previous
 *      one settles, even if two callers kick one off "simultaneously"
 *      within this same server process. Doesn't help two calls landing in
 *      two DIFFERENT server processes/instances, which is what part 2 is
 *      for.
 *   2. `runGit`: retries a command a few times with a short backoff
 *      SPECIFICALLY when the failure is the classic "index.lock: File
 *      exists" transient condition (another process -- possibly in a
 *      different server instance -- holds the lock right now, but
 *      releases it within milliseconds under normal operation). Any other
 *      git failure is returned as-is on the first try, unchanged from
 *      before -- this only ever adds patience for the one specific,
 *      genuinely-transient error shape.
 */
const chainByChat = new Map<string, Promise<unknown>>();

function withChatSerialized<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chainByChat.get(chatId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  // Swallow so one failed call doesn't poison the chain for the next
  // caller -- each `.then(fn, fn)` above already ran `fn` either way;
  // this is purely to keep `chainByChat`'s stored promise from becoming a
  // permanently-rejected value that every future `.then()` off it would
  // otherwise inherit.
  chainByChat.set(chatId, next.catch(() => {}));
  return next;
}

const isLockContention = (stderr: string) => /Unable to create '.*index\.lock': File exists/i.test(stderr);

async function runGit(
  sandbox: VersionCaptureSandbox,
  command: string,
  opts: { retries?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const retries = opts.retries ?? 4;
  let result = await sandbox.run({ command });
  for (let attempt = 0; attempt < retries && result.exitCode !== 0 && isLockContention(result.stderr); attempt++) {
    // Short, increasing backoff (120ms, 240ms, 360ms, 480ms) -- long
    // enough for another in-flight `git commit`/`git add` to have
    // actually released the lock, short enough that even the worst case
    // (all retries exhausted) adds well under a second to a turn that
    // was going to run this command anyway.
    await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
    result = await sandbox.run({ command });
  }
  return result;
}

/**
 * Detects EVERY file change made during the turn that just ended --
 * regardless of which tool made it (write_file, edit_file, append_file,
 * a raw `bash` rm/mv/sed/redirect, a generated build artifact, anything)
 * -- by diffing the sandbox's real filesystem against a git baseline
 * committed at the end of the previous turn. Records one ChatVersion
 * (same schema, same card-append behavior as before) if anything
 * changed, then re-commits so the next turn's diff starts from a clean
 * baseline again.
 *
 * First-ever call for a chat just initializes the git baseline (no
 * ChatVersion is created for it -- there's nothing to compare against
 * yet, this IS the starting point) and returns null.
 *
 * Best-effort throughout: a git hiccup here should never surface as a
 * user-visible failure on an otherwise-successful turn, same philosophy
 * as touchChatFileTree/trackChange elsewhere in this feature.
 */
export function captureVersionFromSandboxDiff(
  chatId: string,
  sandbox: VersionCaptureSandbox,
): Promise<{ versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number } | null> {
  return withChatSerialized(chatId, () => captureVersionFromSandboxDiffInner(chatId, sandbox));
}

async function captureVersionFromSandboxDiffInner(
  chatId: string,
  sandbox: VersionCaptureSandbox,
): Promise<{ versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number } | null> {
  try {
    const initCheck = await runGit(sandbox, 'git rev-parse --is-inside-work-tree 2>/dev/null || echo NO_REPO');
    const alreadyInitialized = initCheck.stdout.trim() === 'true';

    if (!alreadyInitialized) {
      await runGit(sandbox, [
          'git init -q',
          'git config user.email "agent@entry.internal"',
          'git config user.name "Entry Agent"',
          `printf '%s' ${JSON.stringify(GIT_IGNORE_CONTENTS)} > .gitignore`,
          'git add -A',
          'git commit -q -m "baseline" --allow-empty',
        ].join(' && '));
      return null; // baseline only -- nothing to diff against yet
    }

    // Rewrite .gitignore + untrack anything matching it EVERY turn, not
    // just at first init -- a chat whose baseline was committed before
    // this fix (i.e. almost every existing chat) already has an older,
    // shorter .gitignore on disk, and a .gitignore change alone never
    // un-tracks a path git already committed. `git rm -r --cached` is a
    // no-op (exit 128, ignored via `|| true`) for any name that was
    // never tracked, so this is safe to run unconditionally every time.
    const untrackCmd = IGNORED_DIR_NAMES.map(d => `git rm -r --cached ${JSON.stringify(d)} >/dev/null 2>&1 || true`).join(' && ');
    await runGit(sandbox, [`printf '%s' ${JSON.stringify(GIT_IGNORE_CONTENTS)} > .gitignore`, untrackCmd].join(' && '));

    // NESTED-REPO / GITLINK GUARD (2026-07-19, real bug from production
    // logs: `fatal: bad object :entry-seo`). If the agent ever ran `git
    // init`/`git clone` inside one of its own project subdirectories
    // (e.g. cloning/pushing a real project named "entry-seo" via the
    // GitHub Connect flow -- completely routine), that subdirectory now
    // has its OWN `.git` folder. From THIS shadow versioning repo's
    // perspective at the sandbox root, `git add -A` then sees a directory
    // containing a nested `.git` and records it as a git SUBMODULE
    // (gitlink, mode 160000) -- a pointer to a commit SHA, not a blob --
    // instead of as normal tracked files. `git show :<path>` on a gitlink
    // has no blob content to return and fails outright with exactly
    // "fatal: bad object", which used to bubble up as a hard, repeated
    // per-turn error and silently drop that turn's whole versioning
    // capture (return null via the catch below) -- not just for that one
    // project folder, for the ENTIRE turn's diff, including any other,
    // unrelated real file changes made in the same turn.
    //
    // Fix: detect any nested-repo directory before diffing, untrack it
    // (git already treats a no-op `rm -r --cached` on something never
    // tracked as harmless), and add it to the ignore list so it's never
    // re-added as a gitlink again. This shadow repo only exists to power
    // the in-chat version/revert feature -- it was never trying to track
    // a project's own separate git history, so excluding it here loses
    // nothing the user actually wanted from THIS feature.
    const nestedGitDirsResult = await sandbox.run({
      command: `find . -mindepth 2 -maxdepth 6 -type d -name .git -not -path "./.git*" 2>/dev/null`,
    });
    const nestedGitDirs = nestedGitDirsResult.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      // Strip the trailing `/.git` to get the actual project directory path.
      .map(p => p.replace(/^\.\//, '').replace(/\/\.git$/, ''))
      .filter(Boolean);
    if (nestedGitDirs.length > 0) {
      const untrackNestedCmd = nestedGitDirs
        .map(d => `git rm -r --cached ${JSON.stringify(d)} >/dev/null 2>&1 || true`)
        .join(' && ');
      await runGit(sandbox, untrackNestedCmd);
    }
    const isNestedRepoPath = (p: string) => nestedGitDirs.some(d => p === d || p.startsWith(`${d}/`));

    await runGit(sandbox, 'git add -A');
    const statusResult = await runGit(sandbox, "git diff --cached --name-status --no-renames");
    const lines = statusResult.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null; // nothing changed this turn

    // BINARY GUARD (2026-07-19). `git show :<path>` on a binary file
    // (image, zip, sqlite db, font...) dumps raw bytes into stdout ->
    // stored as "text" in ChatVersionFile.content -> silently corrupted
    // on the round-trip (NUL bytes don't survive Postgres text columns /
    // JSON transport), and restoreLatestFilesToSandbox would then write
    // that garbage back over the real file. git already knows which
    // staged paths are binary: numstat reports "-\t-" for them. Capture
    // those as metadata-only rows (content null, like deletes) -- the
    // card still shows the change, diffs/restores just skip the bytes.
    // Same numstat pass also flags oversized text files: a single
    // captured file is capped at 2MB -- past that it's build output or
    // a dataset, not something the diff viewer or restore path can
    // usefully handle, and one giant row per turn bloats the table fast.
    const numstatResult = await runGit(sandbox, 'git diff --cached --numstat --no-renames');
    const binaryPaths = new Set(
      numstatResult.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-\t-\t'))
        .map(l => l.split('\t').slice(2).join('\t'))
        .filter(Boolean),
    );
    const MAX_CAPTURED_FILE_BYTES = 2 * 1024 * 1024;

    const changes: PendingChange[] = [];
    // Belt-and-suspenders on top of the untrack step above: a path being
    // un-tracked THIS turn (because it matched a newly-added ignore rule
    // on an older baseline) shows up right here as a plain 'D' delete --
    // correct in that it really is leaving the index, but showing the
    // user a version card like "5 files deleted: vercel-latest.json,
    // telemetry-session.json..." is just a different flavor of the same
    // noise this fix is trying to remove, not a real project change.
    // Filter those out of the CARD entirely rather than special-casing
    // the summary text -- there is nothing genuinely worth showing here.
    const isIgnoredToolingPath = (p: string) => IGNORED_DIR_NAMES.some(d => p === d || p.startsWith(`${d}/`));

    for (const line of lines) {
      const [statusCode, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      if (!path || isIgnoredToolingPath(path) || isNestedRepoPath(path)) continue;
      const code = statusCode[0];
      if (code === 'D') {
        changes.push({ path, changeType: 'deleted', content: null });
      } else {
        const changeType = code === 'A' ? ('added' as const) : ('modified' as const);
        // Binary/oversized guard (see numstat pass above): capture as a
        // metadata-only row instead of corrupting bytes through a text
        // column. content '' (not null) so it isn't mistaken for a delete.
        if (binaryPaths.has(path)) {
          changes.push({ path, changeType, content: '' });
          continue;
        }
        // 'A' (added) or 'M' (modified) -- read the STAGED content (what
        // was just `git add -A`'d), not the working tree, so this is
        // exactly what will be committed as this turn's baseline below.
        const safePath = JSON.stringify(path);
        const showResult = await runGit(sandbox, `git show :${safePath}`);
        const content = showResult.exitCode === 0 ? showResult.stdout : '';
        changes.push({ path, changeType, content: content.length > MAX_CAPTURED_FILE_BYTES ? '' : content });
      }
    }

    const info = await writeVersionRows(chatId, changes, {});

    // Re-commit so next turn's `git diff --cached` starts from a clean
    // baseline -- runs regardless of whether writeVersionRows actually
    // produced a version (e.g. a transient DB hiccup shouldn't leave the
    // git index permanently dirty and re-diff the same changes forever).
    await runGit(sandbox, `git commit -q -m "version ${info?.versionNumber ?? 'unrecorded'}" --allow-empty`);

    return info;
  } catch (err) {
    console.error('[chat-versioning] captureVersionFromSandboxDiff failed', chatId, err);
    return null;
  }
}

/**
 * Appends a lightweight, self-contained "version card" message to a
 * direct/BYOK chat's persisted `events` (a real AI SDK UIMessage[] for
 * that chat shape -- see EveChatSession.events' schema comment). Renders
 * client-side via the `data-version-card` part type
 * (components/chat/renderers/version-card.tsx). Deliberately a no-op for
 * eve-default-path chats: their `events` holds eve's own
 * HandleMessageStreamEvent[] log, a completely different shape that this
 * app's eve event-reducer/replay owns end to end -- splicing a raw
 * UIMessage into that array would corrupt it. Matches the same
 * eve-vs-direct split already established for revert (`canRevertLive` in
 * the versions list route) and the Files tab. Eve-default chats instead
 * get their card rendered CLIENT-SIDE, purely locally (never persisted
 * into `events`) -- see chat-interface.tsx's `turn.completed` handling,
 * which fetches this same version from the read-only versions-list route
 * the instant that event arrives.
 *
 * Best-effort by design (same philosophy as touchChatFileTree /
 * scheduleVersionFlush elsewhere in this feature): the version itself is
 * already durably recorded in ChatVersion/ChatVersionFile by the time
 * this runs, so a failure here just means the chat-visible card doesn't
 * show up immediately -- the version is still fully there in the History
 * page / diff API, never silently lost.
 */
/**
 * REAL BUG FIXED (2026-07-16, user-reported: "the sandbox had been wiped
 * again between turns... the file was gone entirely... had to recreate
 * it" + separately "the whole versioning system is not working"). Root
 * cause, confirmed by reading both sandbox-creation call sites end to
 * end: E2B sandboxes have no persistent disk across an eviction/kill
 * (idle timeout, org concurrency limit, a genuinely wedged VM, anything)
 * -- `Sandbox.connect(existingId)` just throws, and BOTH the eve-default
 * path (e2b-backend.ts's `create()`) and the BYOK path
 * (direct-chat/sandbox.ts's `getSandboxForChat`) silently fell back to
 * `Sandbox.create()` from the bare shared template with ZERO restoration
 * of whatever files were actually there before -- no error surfaced
 * anywhere, so it looked exactly like "the agent randomly deleted my
 * files" from the user's side. It also silently broke versioning: a
 * fresh sandbox has no git repo, so captureVersionFromSandboxDiff just
 * re-initializes a brand new empty baseline and reports nothing changed,
 * even though the whole project just vanished.
 *
 * Fix: this project's own ChatVersionFile rows are ALREADY a complete,
 * durable, full-content snapshot of every tracked path as of the latest
 * version -- exactly what's needed to rebuild a blank sandbox's
 * filesystem. Call this immediately after creating any fallback/fresh
 * sandbox (both call sites, see their own comments) so an eviction costs
 * a few seconds of re-materializing files instead of losing them. Then
 * re-initializes the git baseline against the restored state so the next
 * captureVersionFromSandboxDiff call diffs from here, not from empty (an
 * empty baseline would otherwise re-report every restored file as a
 * brand new "added" change on the very next turn).
 *
 * Best-effort, same philosophy as everything else in this file: a
 * restore failure here should never throw and break the sandbox handoff
 * itself -- worst case is the same pre-fix behavior (blank sandbox), not
 * a new failure mode.
 */
/**
 * Runs `fn` (the sandbox's actual long-running work -- a single `bash`
 * call, most commonly) while periodically calling
 * captureVersionFromSandboxDiff in the BACKGROUND every `intervalMs`,
 * not just once fn() finishes.
 *
 * REAL GAP THIS CLOSES (2026-07-18, "improve sandbox saving x6"):
 * per-step/per-turn capture (version-capture.ts's hook, direct/chat's
 * onStepFinish/onFinish) only ever runs AFTER a step or turn completes.
 * A SINGLE long-running command -- a clone+install+build pipeline run as
 * one `bash` call, which is exactly the pattern this codebase's own docs
 * tell the model to use -- never reaches that point at all if it gets
 * hard-killed mid-run (bash.ts's own 240s ceiling, or the outer route's
 * 300s maxDuration hitting first). Everything that command had already
 * written to disk before the kill was still being silently lost on the
 * next eviction, even with per-step capture in place, because per-step
 * capture has nothing to fire after until the step itself resolves.
 *
 * Two capture systems now run concurrently against the same sandbox for
 * the same command: this one (every intervalMs while it's in flight) and
 * the per-step one (once it finishes). `inFlight` guards against two
 * overlapping git commits racing each other if a capture happens to
 * still be running when the next interval tick fires. Default tightened
 * 30s -> 10s (2026-07-18, user-requested further improvement) -- still
 * comfortably under bash.ts's 240s ceiling (now ~24 possible capture
 * points across a full-length command instead of ~8) without spamming
 * the sandbox with git commands for short/instant ones -- the interval
 * never even fires once for anything that finishes in under 10s, and
 * clearInterval on completion means a fast command has zero extra
 * overhead either way.
 *
 * Best-effort throughout, same philosophy as captureVersionFromSandboxDiff
 * itself: a failed background capture is logged and swallowed, never
 * surfaced as if `fn` itself (the actual command the user/agent cares
 * about) had failed.
 */
export function withPeriodicVersionCapture<T>(
  chatId: string,
  sandbox: VersionCaptureSandbox,
  fn: () => Promise<T>,
  intervalMs = 10_000,
): Promise<T> {
  let inFlight = false;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    captureVersionFromSandboxDiff(chatId, sandbox)
      .catch(err => console.error('[chat-versioning] periodic capture failed', chatId, err))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return fn().finally(() => clearInterval(timer));
}

export async function restoreLatestFilesToSandbox(chatId: string, sandbox: VersionCaptureSandbox): Promise<number> {
  try {
    const latest = await prisma.$queryRaw<Array<{ path: string; change_type: string; content: string | null }>>`
      SELECT DISTINCT ON (path) path, change_type, content
      FROM chat_version_files
      WHERE chat_id = ${chatId}
      ORDER BY path, version_number DESC
    `;
    const live = latest.filter(r => r.change_type !== 'deleted' && r.content != null);
    if (live.length === 0) return 0;

    // Batched into chunks (not one file per round trip, not one giant
    // command) -- keeps this fast (the actual "agent is slow" complaint
    // elsewhere) while staying well under any single-command length
    // limit even for a project with hundreds of tracked files.
    const CHUNK_SIZE = 25;
    for (let i = 0; i < live.length; i += CHUNK_SIZE) {
      const chunk = live.slice(i, i + CHUNK_SIZE);
      const cmds = chunk.map(file => {
        const b64 = Buffer.from(file.content ?? '', 'utf8').toString('base64');
        const safePath = JSON.stringify(file.path);
        return `mkdir -p "$(dirname ${safePath})" && printf '%s' ${JSON.stringify(b64)} | base64 -d > ${safePath}`;
      });
      await sandbox.run({ command: cmds.join(' && ') });
    }

    await runGit(sandbox, [
        'git init -q',
        'git config user.email "agent@entry.internal"',
        'git config user.name "Entry Agent"',
        `printf '%s' ${JSON.stringify(GIT_IGNORE_CONTENTS)} > .gitignore`,
        'git add -A',
        'git commit -q -m "restored baseline" --allow-empty',
      ].join(' && '));

    return live.length;
  } catch (err) {
    console.error('[chat-versioning] restoreLatestFilesToSandbox failed', chatId, err);
    return 0;
  }
}

async function appendVersionCardMessage(
  chatId: string,
  info: { versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number; revertedFromVersionNumber?: number },
): Promise<void> {
  try {
    const chat = await prisma.eveChatSession.findUnique({ where: { id: chatId } });
    if (!chat || (!chat.byokModelId && !chat.requestedModel)) return; // eve-default path -- skip, see comment above

    const events = Array.isArray(chat.events) ? (chat.events as unknown[]) : [];
    const cardMessage = {
      id: `version-card-${info.versionNumber}`,
      role: 'assistant',
      parts: [
        {
          type: 'data-version-card',
          data: {
            versionNumber: info.versionNumber,
            summary: info.summary,
            filesChanged: info.filesChanged,
            linesAdded: info.linesAdded,
            linesRemoved: info.linesRemoved,
            revertedFromVersionNumber: info.revertedFromVersionNumber ?? null,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    };
    await prisma.eveChatSession.update({
      where: { id: chatId },
      data: { events: [...events, cardMessage] as any },
    });
  } catch (err) {
    console.error('[chat-versioning] appendVersionCardMessage failed', chatId, err);
  }
}

export async function getFileDiffContent(
  chatId: string,
  versionNumber: number,
  path: string,
): Promise<{ changeType: ChangeType; before: string | null; after: string | null } | null> {
  const file = await prisma.chatVersionFile.findFirst({ where: { chatId, versionNumber, path } });
  if (!file) return null;
  const before = await prisma.chatVersionFile.findFirst({
    where: { chatId, path, versionNumber: { lt: versionNumber } },
    orderBy: { versionNumber: 'desc' },
  });
  return {
    changeType: file.changeType as ChangeType,
    before: before && before.changeType !== 'deleted' ? before.content : null,
    after: file.content,
  };
}

export interface RevertFileAction {
  path: string;
  action: 'write' | 'delete';
  content: string | null;
}

/**
 * Computes what needs to happen to the LIVE sandbox to make it match
 * `targetVersionNumber`'s state exactly -- both files that need their
 * content restored, and files that need to be deleted because they
 * didn't exist yet as of that version (created by a later one).
 * Pure/read-only: does not touch the sandbox or write any DB rows itself
 * -- the caller applies the actions to the real sandbox, then calls
 * `flushPendingVersion` (after recording each applied change) to log the
 * revert as a new, honest, forward-only version.
 */
export async function planRevert(chatId: string, targetVersionNumber: number): Promise<RevertFileAction[]> {
  const currentHead = await prisma.chatVersion.findFirst({ where: { chatId }, orderBy: { versionNumber: 'desc' } });
  if (!currentHead) return [];

  // Latest known state of every tracked path AS OF the target version.
  const asOfTarget = await prisma.$queryRaw<Array<{ path: string; change_type: string; content: string | null }>>`
    SELECT DISTINCT ON (path) path, change_type, content
    FROM chat_version_files
    WHERE chat_id = ${chatId} AND version_number <= ${targetVersionNumber}
    ORDER BY path, version_number DESC
  `;

  // Latest known state of every tracked path AS OF the current head (now).
  const asOfHead = await prisma.$queryRaw<Array<{ path: string; change_type: string }>>`
    SELECT DISTINCT ON (path) path, change_type
    FROM chat_version_files
    WHERE chat_id = ${chatId} AND version_number <= ${currentHead.versionNumber}
    ORDER BY path, version_number DESC
  `;

  const targetByPath = new Map(asOfTarget.map(r => [r.path, r]));
  const headPaths = new Set(asOfHead.filter(r => r.change_type !== 'deleted').map(r => r.path));

  const actions: RevertFileAction[] = [];

  for (const row of asOfTarget) {
    if (row.change_type === 'deleted') {
      if (headPaths.has(row.path)) actions.push({ path: row.path, action: 'delete', content: null });
    } else {
      actions.push({ path: row.path, action: 'write', content: row.content });
    }
  }

  // Files that exist now but didn't exist yet as of the target version
  // (created by some version AFTER the target) -- must be removed.
  for (const path of headPaths) {
    if (!targetByPath.has(path)) actions.push({ path, action: 'delete', content: null });
  }

  return actions;
}

/**
 * Single-file revert (2026-07-17, "improve history and versioning" push
 * -- real gap: the only revert action was the whole version snapshot;
 * if 11 files changed in a version and only one of them needs rolling
 * back, the old-only option threw away the other 10 files' progress
 * too). Same before/after model as `planRevert`, just scoped to one
 * path instead of every tracked path -- returns null when there's
 * nothing to actually do (the path's content as of the target version
 * already matches its current live content, or neither version nor the
 * live state ever tracked this path at all).
 */
export async function planRevertSingleFile(
  chatId: string,
  targetVersionNumber: number,
  path: string,
): Promise<RevertFileAction | null> {
  const asOfTarget = await prisma.chatVersionFile.findFirst({
    where: { chatId, path, versionNumber: { lte: targetVersionNumber } },
    orderBy: { versionNumber: 'desc' },
  });
  const asOfHead = await prisma.chatVersionFile.findFirst({
    where: { chatId, path },
    orderBy: { versionNumber: 'desc' },
  });

  const targetIsLive = asOfTarget && asOfTarget.changeType !== 'deleted';
  const headIsLive = asOfHead && asOfHead.changeType !== 'deleted';

  if (!targetIsLive) {
    // Didn't exist (or was deleted) as of the target version -- if it
    // exists live now, that means a later version created/restored it,
    // so reverting this one file means deleting it again.
    return headIsLive ? { path, action: 'delete', content: null } : null;
  }

  if (headIsLive && asOfHead!.content === asOfTarget!.content) return null; // already matches -- no-op
  return { path, action: 'write', content: asOfTarget!.content };
}

/**
 * Full-content snapshot of every live (non-deleted) tracked path as of
 * a given version -- the read side of `restoreLatestFilesToSandbox`'s
 * same query, pulled out standalone for the version-snapshot download
 * endpoint (2026-07-17). Deliberately pure-DB, no sandbox involved: this
 * is what makes it work for BOTH direct/BYOK AND eve-default chats alike
 * (unlike revert, which needs a live sandbox to actually write into),
 * since every ChatVersionFile row is already a complete stored copy of
 * that file's content at that point -- nothing to fetch from a sandbox
 * at all.
 */
export async function getSnapshotFiles(
  chatId: string,
  versionNumber: number,
): Promise<Array<{ path: string; content: string }>> {
  const rows = await prisma.$queryRaw<Array<{ path: string; change_type: string; content: string | null }>>`
    SELECT DISTINCT ON (path) path, change_type, content
    FROM chat_version_files
    WHERE chat_id = ${chatId} AND version_number <= ${versionNumber}
    ORDER BY path, version_number DESC
  `;
  return rows.filter(r => r.change_type !== 'deleted' && r.content != null).map(r => ({ path: r.path, content: r.content! }));
}
