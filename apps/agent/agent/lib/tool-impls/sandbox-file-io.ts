import type { ToolExecCtx } from './types.js';
import { prisma } from '@entry/db';

/**
 * Shared low-level sandbox file I/O for write_file.ts, edit_file.ts,
 * append_file.ts, and read_file.ts.
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
 *
 * ADVANCED PASS (2026-07-20) -- four hardening additions applied here
 * once so every tool built on top (write/edit/append/read) gets them for
 * free, with zero per-tool duplication:
 *
 * 1. `validateSandboxPath` -- rejects absolute paths, null bytes, and any
 *    `..` segment that would walk the resolved path above the project
 *    root. Previously a path was handed straight to `dirname`/the shell
 *    with no validation at all.
 * 2. `encoding: 'utf8' | 'base64'` on write/append/read -- the whole
 *    family previously only supported text content (a real binary file
 *    written through write_file would get mangled the moment JS treated
 *    its bytes as UTF-8). Passing `encoding: 'base64'` on write/append
 *    means the caller's `content` IS ALREADY base64 (skips the JS-side
 *    re-encode since it's already in the wire format the sandbox needs);
 *    passing it on read returns base64 instead of running the file's raw
 *    bytes through JS string decoding.
 * 3. A hard per-call size ceiling (MAX_CONTENT_BYTES) with a clear error
 *    pointing at append_file for anything bigger, instead of silently
 *    attempting (and risking) an oversized single round-trip.
 * 4. A post-write integrity check: the size actually reported back by
 *    `stat` after decode is compared against the byte length we expected
 *    to write. Every past bug this tool family's comments reference
 *    ("AI just stays stuck", "silently truncates, no error, no file") was
 *    exactly this failure mode happening invisibly -- so rather than only
 *    guarding against it on the model's INPUT side (small chunks via
 *    append_file), this catches it on the way OUT too: if what actually
 *    landed on disk doesn't match what we told the shell to write, that's
 *    surfaced as a real tool error instead of a silent, wrong success.
 */

const MAX_CONTENT_BYTES = 15 * 1024 * 1024; // 15MB per single write/read -- use append_file to chunk anything bigger.

export function validateSandboxPath(path: string): string | null {
  if (typeof path !== 'string' || path.trim().length === 0) return 'Path must not be empty.';
  if (path.includes('\0')) return 'Path must not contain a null byte.';
  if (path.startsWith('/')) return 'Path must be relative to the project root -- do not start with "/".';
  if (/^[A-Za-z]:[\\/]/.test(path)) return 'Path must be a relative POSIX path, not a Windows/absolute path.';
  let depth = 0;
  for (const seg of path.split('/')) {
    if (seg === '..') {
      depth--;
      if (depth < 0) return `Path "${path}" escapes the project root via "..".`;
    } else if (seg !== '.' && seg !== '') {
      depth++;
    }
  }
  return null;
}

type Encoding = 'utf8' | 'base64';

function toBase64Payload(content: string, encoding: Encoding): { ok: true; b64: string; bytes: number } | { ok: false; error: string } {
  if (encoding === 'base64') {
    const normalized = content.replace(/\s/g, '');
    if (normalized !== '' && !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return { ok: false, error: 'content is not valid base64 (encoding: "base64" was requested).' };
    }
    return { ok: true, b64: normalized, bytes: Buffer.from(normalized, 'base64').length };
  }
  return { ok: true, b64: Buffer.from(content, 'utf8').toString('base64'), bytes: Buffer.byteLength(content, 'utf8') };
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

export interface WriteFileOptions {
  encoding?: Encoding;
  /** When true, refuse to overwrite a file that already exists. */
  createOnly?: boolean;
}

export interface WriteFileResult {
  ok: true;
  created: boolean;
  bytesWritten: number;
  previousBytes?: number;
  /** Non-fatal heads-up, e.g. a suspicious shrink vs. the previous file -- worth a second look, not necessarily wrong. */
  warning?: string;
}

export async function sandboxWriteFile(
  ctx: ToolExecCtx,
  path: string,
  content: string,
  opts: WriteFileOptions = {},
): Promise<WriteFileResult | { ok: false; error: string }> {
  const pathErr = validateSandboxPath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const encoding = opts.encoding ?? 'utf8';
  const payload = toBase64Payload(content, encoding);
  if (!payload.ok) return payload;
  if (payload.bytes > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: `Content is ${payload.bytes} bytes, over the ${Math.floor(MAX_CONTENT_BYTES / (1024 * 1024))}MB single-write limit -- use append_file to build it up in chunks instead.`,
    };
  }

  const sandbox = await ctx.getSandbox();
  const safePath = JSON.stringify(path);
  const b64 = payload.b64;

  // One round trip: previous size (or -1 sentinel if missing) + optional
  // create-only guard + the write itself + the new size, all chained so
  // there's exactly one network hop to the sandbox regardless of options.
  const cmd = opts.createOnly
    ? `if [ -e ${safePath} ]; then echo __CREATE_ONLY_EXISTS__ 1>&2; exit 4; fi; mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath} && echo -1 && stat -c%s ${safePath}`
    : `PREV=$(stat -c%s ${safePath} 2>/dev/null || echo -1); mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath} && echo "$PREV" && stat -c%s ${safePath}`;

  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    if (result.stderr.includes('__CREATE_ONLY_EXISTS__')) {
      return { ok: false, error: `"${path}" already exists -- createOnly was set, refusing to overwrite. Read it first, or drop createOnly to overwrite intentionally.` };
    }
    return { ok: false, error: result.stderr.slice(0, 500) || `Write failed with exit code ${result.exitCode}` };
  }

  const lines = result.stdout.trim().split('\n');
  const prevRaw = Number(lines[0]);
  const previousBytes = Number.isFinite(prevRaw) && prevRaw >= 0 ? prevRaw : undefined;
  const created = !(Number.isFinite(prevRaw) && prevRaw >= 0);
  const newSize = parseTrailingSize(result.stdout) ?? payload.bytes;

  if (newSize !== payload.bytes) {
    return {
      ok: false,
      error: `Integrity check failed: expected to write ${payload.bytes} bytes but the sandbox reports ${newSize} bytes on disk. The write may have been interrupted or corrupted -- do not assume "${path}" is correct, re-check it before continuing.`,
    };
  }

  let warning: string | undefined;
  if (!created && previousBytes !== undefined && previousBytes > 2000 && newSize < previousBytes * 0.2) {
    warning = `New content (${newSize} bytes) is much smaller than the previous file (${previousBytes} bytes) -- double-check this wasn't meant to be a partial edit (use edit_file for targeted changes) rather than a full overwrite.`;
  }

  await touchChatFileTree(ctx.session.id, path, newSize);
  return { ok: true, created, bytesWritten: newSize, previousBytes, ...(warning ? { warning } : {}) };
}

export interface ReadFileOptions {
  encoding?: Encoding;
}

export async function sandboxReadFile(
  ctx: ToolExecCtx,
  path: string,
  opts: ReadFileOptions = {},
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const pathErr = validateSandboxPath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const sandbox = await ctx.getSandbox();
  const safePath = JSON.stringify(path);
  const encoding = opts.encoding ?? 'utf8';
  const cmd = encoding === 'base64' ? `base64 -w0 ${safePath}` : `cat ${safePath}`;
  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.slice(0, 500) || `"${path}" not found` };
  }
  return { ok: true, content: result.stdout };
}

export interface AppendFileOptions {
  encoding?: Encoding;
}

export async function sandboxAppendFile(
  ctx: ToolExecCtx,
  path: string,
  content: string,
  mode: 'start' | 'append',
  opts: AppendFileOptions = {},
): Promise<{ ok: true; bytesWritten: number } | { ok: false; error: string }> {
  const pathErr = validateSandboxPath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const encoding = opts.encoding ?? 'utf8';
  const payload = toBase64Payload(content, encoding);
  if (!payload.ok) return payload;
  if (payload.bytes > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: `This chunk is ${payload.bytes} bytes, over the ${Math.floor(MAX_CONTENT_BYTES / (1024 * 1024))}MB per-call limit -- split it into smaller chunks.`,
    };
  }

  const sandbox = await ctx.getSandbox();
  const b64 = payload.b64;
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
  return { ok: true, bytesWritten: payload.bytes };
}
