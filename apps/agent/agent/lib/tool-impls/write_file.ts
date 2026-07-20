import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
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
 *
 * ADVANCED PASS (2026-07-20):
 * - `encoding: 'base64'` -- write real binary files (images, zips,
 *   fonts, etc.) without corrupting them by round-tripping through JS's
 *   UTF-8 string handling. Default stays 'utf8' for normal text/code.
 * - `createOnly` -- refuse to overwrite an existing file, for the times
 *   the model wants a hard guarantee it's creating something new rather
 *   than silently clobbering an existing file at that path.
 * - Output now reports `created` (true/false), and a non-fatal `warning`
 *   if the new content is suspiciously much smaller than what was there
 *   before (a cheap, free signal for exactly the "silently truncated"
 *   failure class this whole tool family exists to avoid) -- plus an
 *   integrity check (shared in sandbox-file-io.ts) that turns a corrupted
 *   write into a real error instead of a silent wrong success.
 */
export const writeFileTool = {
  description:
    'Create a new file or fully overwrite an existing one in the sandbox with the given content. ' +
    'Use this for NEW files or SHORT files only. For editing an EXISTING file that is already long ' +
    '(roughly 200+ lines), use `edit_file` instead to make a targeted change -- do not reprint the whole ' +
    "file here, that risks silently truncating mid-write on a long file. Set encoding: 'base64' to write " +
    'binary content (images, zips, etc.) safely. Set createOnly: true to refuse overwriting an existing file.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to create/overwrite.'),
    content: z.string().describe("The full file content to write. If encoding is 'base64', this must already be base64-encoded."),
    encoding: z
      .enum(['utf8', 'base64'])
      .optional()
      .describe("'utf8' (default) for text/code. 'base64' for binary files -- pass already-base64-encoded content."),
    createOnly: z
      .boolean()
      .optional()
      .describe('If true, fail instead of overwriting when the file already exists. Default false (overwrites normally).'),
  }),
  async execute(
    { path, content, encoding, createOnly }: { path: string; content: string; encoding?: 'utf8' | 'base64'; createOnly?: boolean },
    ctx: ToolExecCtx,
  ) {
    const result = await sandboxWriteFile(ctx, path, content, { encoding, createOnly });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      path,
      created: result.created,
      bytesWritten: result.bytesWritten,
      ...(result.previousBytes !== undefined ? { previousBytes: result.previousBytes } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    };
  },
};

writeFileTool.execute = safeExecute('write_file', writeFileTool.execute) as typeof writeFileTool.execute;
Object.assign(writeFileTool, withAgentTimeout('write_file', writeFileTool));
