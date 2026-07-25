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
// FIXED (2026-07-25, real production failure: AI_InvalidToolInputError,
// confirmed via error_logs on chatId pNoDkjoDqK9Ild5D, Claude Opus mid-turn
// during a real user task). Claude models are heavily trained on
// Anthropic's OWN built-in `str_replace_based_edit_tool` / text_editor
// tool, whose parameters are literally named `old_str`/`new_str` -- so
// despite this tool's description and schema saying `old_text`/`new_text`,
// Claude periodically calls it with the OTHER, equally-natural-to-it
// naming anyway (worse under load/distraction, but not exclusively --
// it's a genuine trained habit, not a one-off slip). That mismatch is a
// hard schema validation failure, not a soft "wrong content" mistake --
// the whole tool call is thrown out before `execute` ever runs, wasting a
// full step and, worse, reads to the user as the turn having silently
// died for no reason.
//
// Deliberately NOT a z.preprocess() wrapper here even though that would
// be simpler -- ToolImpl requires a genuine ZodObject (its `.shape` is
// used elsewhere to build the JSON-schema tool declaration sent to the
// model), and z.preprocess()'s return type is a ZodEffects/ZodPreprocess
// wrapper, not a ZodObject, so it fails that type check. Instead:
// old_str/new_str are real, declared-but-optional alias fields on the
// SAME ZodObject (so the model can freely use either naming without any
// validation error), and execute() below picks whichever pair was
// actually provided, preferring the canonical old_text/new_text if both
// happen to be present.
export const editFileTool = {
  description:
    'Make a targeted edit to an EXISTING file by replacing one exact snippet of text with another, without ' +
    "reprinting the rest of the file. This is the PREFERRED way to edit any file that isn't brand new -- " +
    'especially long files -- because the tool call only needs to contain the small changed snippet, not the ' +
    'whole file. `old_text` must match the file\'s current content exactly (including whitespace/indentation) ' +
    'and must appear exactly once, unless `replace_all` is set.',
  inputSchema: z.object({
    path: z.string().describe('Relative path (from the project root) of the file to edit.'),
    old_text: z.string().optional().describe('The exact existing text to find and replace. Must match exactly, including whitespace.'),
    new_text: z.string().optional().describe('The text to replace it with.'),
    old_str: z.string().optional().describe('Alias for old_text (accepted for compatibility).'),
    new_str: z.string().optional().describe('Alias for new_text (accepted for compatibility).'),
    replace_all: z.boolean().optional().describe('Replace every occurrence of old_text instead of requiring exactly one match. Default false.'),
  }),
  async execute(
    { path, old_text, new_text, old_str, new_str, replace_all }: {
      path: string;
      old_text?: string;
      new_text?: string;
      old_str?: string;
      new_str?: string;
      replace_all?: boolean;
    },
    ctx: ToolExecCtx
  ) {
    const resolvedOldText = old_text ?? old_str;
    const resolvedNewText = new_text ?? new_str;
    if (resolvedOldText === undefined || resolvedNewText === undefined) {
      return { ok: false, error: 'Both old_text (or old_str) and new_text (or new_str) are required.' };
    }

    const read = await sandboxReadFile(ctx, path);
    if (!read.ok) return { ok: false, error: read.error };

    const { content } = read;
    const old_text_resolved = resolvedOldText;
    const new_text_resolved = resolvedNewText;
    const occurrences = content.split(old_text_resolved).length - 1;

    if (occurrences === 0) {
      return { ok: false, error: `old_text was not found in "${path}". Read the current file content first to get an exact match.` };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        ok: false,
        error: `old_text matches ${occurrences} locations in "${path}". Include more surrounding context to make it unique, or pass replace_all: true to replace all of them.`,
      };
    }

    const updated = replace_all ? content.split(old_text_resolved).join(new_text_resolved) : content.replace(old_text_resolved, new_text_resolved);

    const write = await sandboxWriteFile(ctx, path, updated);
    if (!write.ok) return { ok: false, error: write.error };

    return { ok: true, path, occurrencesReplaced: replace_all ? occurrences : 1 };
  },
};

editFileTool.execute = safeExecute('edit_file', editFileTool.execute) as typeof editFileTool.execute;
Object.assign(editFileTool, withAgentTimeout('edit_file', editFileTool));
