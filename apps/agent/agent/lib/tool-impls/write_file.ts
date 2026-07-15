import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { sandboxWriteFile } from './sandbox-file-io.js';

/**
 * Added 2026-07-15, real bug: "AI just stays stuck working on a long
 * file, nothing happens." Root cause was that the ONLY way to get file
 * content into the sandbox was either a hand-written `cat > file <<'EOF'`
 * bash heredoc, or python_coding's small helper model re-embedding the
 * whole file as an escaped JSON string -- both regenerate the ENTIRE
 * file's content in one shot as part of a single tool call's arguments,
 * which silently truncates the moment a file is long enough to approach
 * that call's output-token ceiling: no error, no file, no visible
 * progress. See persona.ts's tool-calling-guidelines and edit_file.ts's
 * header for the other half of the real fix (targeted in-place edits
 * that never need to touch the whole file at all).
 *
 * This tool exists for the two cases that legitimately DO need the whole
 * file: creating a brand-new file, or fully overwriting a short one. It's
 * still a single argument in one tool call (so it doesn't remove the
 * ceiling), but it's the cheapest possible encoding to get there -- a
 * flat top-level string, no JSON-in-JSON escaping, no shell-metacharacter
 * escaping -- which meaningfully raises how much actual content fits
 * before hitting that ceiling, on top of routing through the PRIMARY
 * model (much larger output budget than python_coding's old small helper
 * model) instead of a secondary sub-call.
 */
export const writeFileTool = {
  description:
    'Create a new file or fully overwrite an existing one in the sandbox with the given content. ' +
    'Use this for NEW files or SHORT files only. For editing an EXISTING file that is already long ' +
    '(roughly 200+ lines), use `edit_file` instead to make a targeted change -- do not reprint the whole ' +
    'file here, that risks silently truncating mid-write on a long file.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to create/overwrite.'),
    content: z.string().describe('The full file content to write.'),
  }),
  async execute({ path, content }: { path: string; content: string }, ctx: ToolExecCtx) {
    const result = await sandboxWriteFile(ctx, path, content);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, path, bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
};

writeFileTool.execute = safeExecute('write_file', writeFileTool.execute) as typeof writeFileTool.execute;
