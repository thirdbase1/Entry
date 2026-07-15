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
