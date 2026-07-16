import type { ToolExecCtx } from './types.js';
import { prisma } from '@entry/db';

/**
 * Shared low-level sandbox file I/O for write_file.ts and edit_file.ts.
 *
 * Content crosses the wire as a plain JS string tool argument (cheapest
 * possible encoding a model can produce -- no JSON-in-JSON re-escaping
 * like the old python_coding generateObject path, no shell-metacharacter
 * escaping like a hand-written `cat > file <<'EOF'` heredoc). Getting
 * that string INTO the sandbox safely is done entirely on our side, not
 * asked of the model: base64-encode it here in trusted JS, then decode it
 * inside the sandbox. Base64's alphabet (A-Za-z0-9+/=) contains no shell
 * metacharacters at all, so it can be safely single-quoted into a shell
 * command with zero escaping edge cases, regardless of what the file's
 * real content contains (quotes, backticks, `$(...)`, literal "EOF"
 * lines, binary-ish text, anything).
 */

/**
 * Added 2026-07-15, real bug: "the Files tab only updates when the AI has
 * stopped working, it's not real-time." Root cause was NOT the 4s poll on
 * the frontend -- it's that the eve-default path's `ChatFileTree` cache
 * row (the only thing GET /api/chats/[id]/files reads for that path) was
 * only ever written by the `list_files` tool, and persona.ts explicitly
 * tells the model to call that "after creating or meaningfully changing
 * files ... not after every tiny edit" -- so by design the cache usually
 * only got refreshed once, near the end of a batch of edits, which reads
 * to a user exactly like "nothing shows up until the AI is done."
 *
 * Fix: every mutation that actually goes through write/append/edit now
 * patches its OWN single entry into the cached tree itself, right here,
 * with zero extra sandbox round-trips (the file's new size comes back
 * piggy-backed on the same `stat` call already chained onto the same
 * shell command as the write -- see how `cmd` is built below). The next
 * 4s poll then always reflects the true current state of every file the
 * agent has touched, not just whatever `list_files` last saw. This is
 * strictly additive to `list_files` (still useful for the initial tree /
 * a full rescan after deletes/renames it can't otherwise infer) -- it
 * doesn't replace it, it just stops the UI depending on the model
 * remembering to call it after every change.
 */
async function touchChatFileTree(chatId: string, path: string, size: number): Promise<void> {
  try {
    const existing = await prisma.chatFileTree.findUnique({ where: { chatId } });
    const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = existing ? JSON.parse(existing.treeJson) : [];
    const idx = entries.findIndex(e => e.path === path);
    const entry = { path, type: 'file' as const, size };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await prisma.chatFileTree.upsert({
      where: { chatId },
      create: { chatId, treeJson: JSON.stringify(entries), rootLabel: existing?.rootLabel ?? null },
      update: { treeJson: JSON.stringify(entries) },
    });
  } catch {
    // Best-effort only -- never let the Files-tab cache fail the actual
    // file write the model is waiting on. A stale/missing tree entry just
    // means that one row shows up late (or via the next list_files call),
    // not a broken tool call.
  }
}

// NOTE (2026-07-16): per-tool-call version tracking (scheduleVersionFlush/
// trackChange) was removed from here -- versioning now happens once per
// turn via a sandbox-wide git diff (captureVersionFromSandboxDiff in
// packages/db/src/chat-versioning.ts), which sees every change regardless
// of which tool made it (write_file/edit_file/append_file, or a raw bash
// rm/mv/sed/redirect that never touched this file at all). See that
// file's header comment for the full story.

// Parses the trailing `stat -c%s` line every write/append command below
// chains onto its own command, so the new file size is known from the
// SAME round-trip that did the write -- no separate sandbox call needed.
function parseTrailingSize(stdout: string): number | null {
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

export async function sandboxWriteFile(ctx: ToolExecCtx, path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sandbox = await ctx.getSandbox();
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const safePath = JSON.stringify(path);
  // Read the file's existing state (if any) BEFORE overwriting, purely to
  // know whether this is an 'added' or 'modified' change for versioning
  // -- one extra tiny round-trip, only for tracking, never blocks/fails
  // the actual write below if it errors.
  const existed = await sandbox.run({ command: `test -f ${safePath} && echo 1 || echo 0` }).then(r => r.stdout.trim() === '1').catch(() => false);
  // `dirname` via a subshell so nested new directories are created on
  // demand (e.g. writing "src/lib/new-module.ts" when "src/lib" doesn't
  // exist yet), same as most editors' "create file" behavior. The
  // trailing `&& stat -c%s` piggy-backs the new size onto this same
  // round-trip for the Files-tab cache update below.
  const cmd = `mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath} && stat -c%s ${safePath}`;
  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.slice(0, 500) || `Write failed with exit code ${result.exitCode}` };
  }
  const size = parseTrailingSize(result.stdout) ?? Buffer.byteLength(content, 'utf8');
  await touchChatFileTree(ctx.session.id, path, size);
  return { ok: true };
}

export async function sandboxReadFile(ctx: ToolExecCtx, path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const sandbox = await ctx.getSandbox();
  const safePath = JSON.stringify(path);
  const result = await sandbox.run({ command: `cat ${safePath}` });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.slice(0, 500) || `"${path}" not found` };
  }
  return { ok: true, content: result.stdout };
}

/**
 * Added 2026-07-15 alongside append_file.ts -- see that file's header.
 * Same base64-over-shell trick as sandboxWriteFile, but appends
 * (`>>`) instead of overwriting (`>`), and takes an explicit `mode` so a
 * chunked multi-call build-up of one new file is unambiguous: `'start'`
 * truncates/creates first (equivalent to write_file with this chunk's
 * content), `'append'` requires the file to already exist and adds to
 * the end of it. Refusing to silently create-on-append is deliberate --
 * a typo'd path with mode:'append' should fail loudly, not quietly start
 * a brand-new file the model didn't intend to create.
 *
 * FIXED 2026-07-15 (real slowness bug): 'append' mode used to be TWO
 * full sandbox round-trips per call -- a `test -f` existence check, then
 * a separate write. Every sandbox.run() is a real network hop to the E2B
 * remote sandbox, so that doubled the latency of every single append
 * call for no reason. Now it's one shell command with the existence
 * check, the append, AND the trailing size stat all chained together --
 * one round-trip total, same as 'start' mode.
 */
export async function sandboxAppendFile(
  ctx: ToolExecCtx,
  path: string,
  content: string,
  mode: 'start' | 'append',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sandbox = await ctx.getSandbox();
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const safePath = JSON.stringify(path);

  const cmd =
    mode === 'start'
      ? `mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath} && stat -c%s ${safePath}`
      : `if [ -f ${safePath} ]; then printf '%s' '${b64}' | base64 -d >> ${safePath} && stat -c%s ${safePath}; else echo "__APPEND_TARGET_MISSING__" 1>&2; exit 3; fi`;

  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    if (result.stderr.includes('__APPEND_TARGET_MISSING__')) {
      return {
        ok: false,
        error: `"${path}" doesn't exist yet -- call append_file with mode: "start" first to create it, then mode: "append" for subsequent chunks.`,
      };
    }
    return { ok: false, error: result.stderr.slice(0, 500) || `Write failed with exit code ${result.exitCode}` };
  }
  const size = parseTrailingSize(result.stdout);
  if (size != null) await touchChatFileTree(ctx.session.id, path, size);
  return { ok: true };
}
