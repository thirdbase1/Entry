import type { ToolExecCtx } from './types.js';

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

export async function sandboxWriteFile(ctx: ToolExecCtx, path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sandbox = await ctx.getSandbox();
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const safePath = JSON.stringify(path);
  // `dirname` via a subshell so nested new directories are created on
  // demand (e.g. writing "src/lib/new-module.ts" when "src/lib" doesn't
  // exist yet), same as most editors' "create file" behavior.
  const cmd = `mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath}`;
  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.slice(0, 500) || `Write failed with exit code ${result.exitCode}` };
  }
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

  if (mode === 'append') {
    const exists = await sandbox.run({ command: `test -f ${safePath}` });
    if (exists.exitCode !== 0) {
      return {
        ok: false,
        error: `"${path}" doesn't exist yet -- call append_file with mode: "start" first to create it, then mode: "append" for subsequent chunks.`,
      };
    }
  }

  const redirect = mode === 'start' ? '>' : '>>';
  const cmd =
    mode === 'start'
      ? `mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d ${redirect} ${safePath}`
      : `printf '%s' '${b64}' | base64 -d ${redirect} ${safePath}`;
  const result = await sandbox.run({ command: cmd });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.slice(0, 500) || `Write failed with exit code ${result.exitCode}` };
  }
  return { ok: true };
}
