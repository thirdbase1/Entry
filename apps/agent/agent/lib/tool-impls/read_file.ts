import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { sandboxReadFile } from './sandbox-file-io.js';

/**
 * Added 2026-07-19, real bug: "Why is there no read tool for reading
 * files" -- AI_NoSuchToolError: Model tried to call unavailable tool
 * 'Read'. Root cause: write_file/edit_file/append_file/list_files all
 * exist as a matched family, but there was never a dedicated file-read
 * tool -- the ONLY way to see a file's content was a raw `bash` call
 * (`cat path`), which works but isn't what a model reaches for. Every
 * mainstream coding-agent tool surface (Claude Code, Cursor, etc.) has a
 * paired Read alongside Write/Edit, so a model naturally assumes one
 * exists here too and hallucinates a call to it instead of falling back
 * to bash -- exactly the trace this fix is responding to.
 *
 * Deliberately its own tool (not "just tell the model to use bash cat" in
 * the persona prompt) for the same reason edit_file exists instead of a
 * `cat > file <<'EOF'` heredoc: structured input/output (explicit
 * ok/error, optional line range) beats parsing raw shell stdout/stderr,
 * and it's what a model already expects to reach for by name.
 *
 * Optional startLine/endLine (1-indexed, inclusive) mirrors the same
 * "don't blow the output-length ceiling" concern write_file/edit_file's
 * header talks about, but for READS instead of writes: a multi-thousand
 * line file dumped whole into one tool result risks the same silent
 * truncation/ballooned-context problem, so a caller that only needs to
 * inspect part of a large file can ask for just that slice. Total
 * returned content is additionally hard-capped (not just line-sliced) so
 * a request for a huge range of a huge file can't still blow the ceiling.
 */
const MAX_CONTENT_CHARS = 100_000;

export const readFileTool = {
  description:
    "Read a file's content from the sandbox's project directory. Returns the full file by default; pass " +
    'startLine/endLine (1-indexed, inclusive) to read only part of a large file. Use this before `edit_file` ' +
    'so you have the exact existing text to match against.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to read.'),
    startLine: z.number().int().positive().optional().describe('First line to include (1-indexed). Omit to start from the beginning.'),
    endLine: z.number().int().positive().optional().describe('Last line to include (1-indexed, inclusive). Omit to read to the end.'),
  }),
  async execute({ path, startLine, endLine }: { path: string; startLine?: number; endLine?: number }, ctx: ToolExecCtx) {
    const result = await sandboxReadFile(ctx, path);
    if (!result.ok) return { ok: false, error: result.error };

    let content = result.content;
    const lines = content.split('\n');
    const totalLines = lines.length;

    if (startLine !== undefined || endLine !== undefined) {
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      if (start > end) {
        return { ok: false, error: `startLine (${start}) is after endLine (${end}); file has ${lines.length} lines.` };
      }
      content = lines.slice(start - 1, end).join('\n');
    }

    let truncated = false;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }

    return { ok: true, path, totalLines, content, truncated };
  },
};

readFileTool.execute = safeExecute('read_file', readFileTool.execute) as typeof readFileTool.execute;
Object.assign(readFileTool, withAgentTimeout('read_file', readFileTool));
