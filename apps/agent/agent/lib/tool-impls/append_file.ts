import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { sandboxAppendFile } from './sandbox-file-io.js';

/**
 * Added 2026-07-15, real bug: "AI_InvalidToolInputError ... Invalid input
 * for tool write_file: AI_TypeValidationError" on a brand-new, long file
 * (a landing page with several inline SVG cards). write_file.ts and
 * edit_file.ts (both added earlier the same day) already solved this for
 * EDITS to an existing long file -- edit_file never needs to reproduce
 * the whole thing. But neither tool helps when the file doesn't exist
 * yet: creating a new file is inherently a write_file call, which is
 * still one tool call carrying the ENTIRE content as a single argument,
 * so a sufficiently long new file can still truncate mid-generation the
 * exact same way (the model's own output-token ceiling cuts the
 * tool-call's JSON arguments off mid-string, so the arguments literally
 * are invalid JSON by the time the whole call finishes -- that's what
 * `AI_TypeValidationError` on write_file's own input actually was).
 *
 * This tool closes that remaining gap: it lets the model build up ONE
 * new (or fully-replaced) file across MULTIPLE tool calls, each call
 * only needing to carry a small chunk -- well within any single call's
 * output budget regardless of how long the finished file ends up being.
 * `mode: "start"` creates/truncates the file with the first chunk;
 * `mode: "append"` adds each subsequent chunk to the end. Use this
 * instead of write_file specifically when you're about to create a new
 * file you expect to be long (roughly 200+ lines, or containing large
 * embedded content like SVGs/base64/long generated markup) -- write a
 * few dozen lines at a time across several append_file calls rather than
 * attempting the whole thing in one write_file call.
 */
export const appendFileTool = {
  description:
    'Build up a NEW file (or fully replace an existing one) across MULTIPLE calls, each carrying only a small chunk of ' +
    'content -- use this instead of `write_file` when creating a file you expect to be long, to avoid the whole-file-in-one-call ' +
    'output-length ceiling that silently truncates and corrupts long single-shot writes. Call with mode: "start" once to create/' +
    'truncate the file with the first chunk, then mode: "append" for each following chunk, in order, until the file is complete.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to build up.'),
    content: z.string().describe('This chunk of content to write/append. Keep each chunk modest in size (e.g. well under what a single write_file call would risk truncating).'),
    mode: z
      .enum(['start', 'append'])
      .describe('"start" creates/truncates the file with this chunk (call this first). "append" adds this chunk to the end of an already-started file.'),
  }),
  async execute({ path, content, mode }: { path: string; content: string; mode: 'start' | 'append' }, ctx: ToolExecCtx) {
    const result = await sandboxAppendFile(ctx, path, content, mode);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, path, mode, bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
};

appendFileTool.execute = safeExecute('append_file', appendFileTool.execute) as typeof appendFileTool.execute;
