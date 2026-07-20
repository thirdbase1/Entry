import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { sandboxReadFile, sandboxWriteFile } from './sandbox-file-io.js';

/**
 * Added 2026-07-15 alongside write_file.ts -- see that file's header for
 * the full "stuck on a long file" root-cause story. THIS tool is the real
 * structural fix, not just a smaller band-aid: it never requires the
 * model to reproduce the file's full content at all, regardless of how
 * long the file is. `old_text`/`new_text` only need to be as long as the
 * actual diff -- a one-line change to a 5,000-line file is a tiny tool
 * call either way, so there is no output-token ceiling to hit in the
 * first place.
 *
 * The exact-match + "must occur exactly once" requirement (same
 * contract as Anthropic's own text_editor `str_replace` tool and
 * Claude Code's Edit tool) is deliberate: it forces the model to include
 * enough surrounding context to unambiguously target one location,
 * rather than silently editing the wrong occurrence of a common snippet.
 */
export const editFileTool = {
  description:
    'Make a targeted edit to an EXISTING file by replacing one exact snippet of text with another, without ' +
    "reprinting the rest of the file. This is the PREFERRED way to edit any file that isn't brand new -- " +
    'especially long files -- because the tool call only needs to contain the small changed snippet, not the ' +
    'whole file. `old_text` must match the file\'s current content exactly (including whitespace/indentation) ' +
    'and must appear exactly once, unless `replace_all` is set.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to edit.'),
    old_text: z.string().describe('The exact existing text to find and replace. Must match exactly, including whitespace.'),
    new_text: z.string().describe('The text to replace it with.'),
    replace_all: z.boolean().optional().describe('Replace every occurrence of old_text instead of requiring exactly one match. Default false.'),
  }),
  async execute(
    { path, old_text, new_text, replace_all }: { path: string; old_text: string; new_text: string; replace_all?: boolean },
    ctx: ToolExecCtx
  ) {
    const read = await sandboxReadFile(ctx, path);
    if (!read.ok) return { ok: false, error: read.error };

    const { content } = read;
    const occurrences = content.split(old_text).length - 1;

    if (occurrences === 0) {
      return { ok: false, error: `old_text was not found in "${path}". Read the current file content first to get an exact match.` };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        ok: false,
        error: `old_text matches ${occurrences} locations in "${path}". Include more surrounding context to make it unique, or pass replace_all: true to replace all of them.`,
      };
    }

    const updated = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, new_text);

    const write = await sandboxWriteFile(ctx, path, updated);
    if (!write.ok) return { ok: false, error: write.error };

    return { ok: true, path, occurrencesReplaced: replace_all ? occurrences : 1 };
  },
};

editFileTool.execute = safeExecute('edit_file', editFileTool.execute) as typeof editFileTool.execute;
Object.assign(editFileTool, withAgentTimeout('edit_file', editFileTool));
