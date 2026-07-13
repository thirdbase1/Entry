import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/**
 * Powers the chat header's "Files" tab (2026-07-13) — the eve-default-
 * path half of the file-tree feature, mirroring get_preview_url.ts's
 * exact split rationale: eve's own sandbox has no external handle outside
 * a live agent turn, so this tool does the whole job itself, from inside
 * the sandbox, and writes the result to a ChatFileTree row keyed by this
 * chat — the ONLY thing the UI's `/api/chats/[sessionId]/files` endpoint
 * reads for an eve-path chat. See persona.ts for when the model is told
 * to call this proactively (right after creating/editing files), same
 * mechanism as the preview panel.
 *
 * Deliberately excludes noisy/huge directories (node_modules, .git,
 * build output, eve's own runtime dirs) so the tree stays small and
 * actually useful — a raw unfiltered `find` on a real project easily
 * returns tens of thousands of entries, which would be both slow to
 * generate and useless to render as a tree.
 */
const EXCLUDED = ['node_modules', '.git', '.next', 'dist', 'build', '.eve', '.vercel', '.turbo', '__pycache__', '.cache'];

export const listFilesTool = {
  description:
    "List the files and folders currently in your sandbox's project directory, so the user can see them in " +
    'the chat header\'s "Files" tab. Call this after creating or meaningfully changing files (new project ' +
    'scaffold, added/removed/renamed files) — not after every tiny edit. Optionally pass a relative `path` to ' +
    'list a specific subdirectory instead of the whole tree.',
  inputSchema: z.object({
    path: z.string().optional().describe('Relative subdirectory to list, e.g. "src". Omit to list the whole project from the current working directory.'),
  }),
  async execute({ path }: { path?: string }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const sandbox = await ctx.getSandbox();
    const target = path && path.trim() ? path.trim().replace(/^\/+/, '') : '.';

    const pruneExpr = EXCLUDED.map(d => `-name ${JSON.stringify(d)}`).join(' -o ');
    const cmd =
      `cd ${JSON.stringify(target)} 2>/dev/null && ` +
      `find . \\( ${pruneExpr} \\) -prune -o -maxdepth 8 -printf '%y|%s|%P\\n' -not -path '.' 2>/dev/null | head -3000`;

    const result = await sandbox.run({ command: cmd });
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { ok: false, error: `Could not list "${target}": ${result.stderr.slice(0, 300) || 'directory not found or empty'}` };
    }

    const entries = result.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [type, size, ...rest] = line.split('|');
        const p = rest.join('|');
        return { path: p, type: type === 'd' ? ('dir' as const) : ('file' as const), size: type === 'f' ? Number(size) || 0 : undefined };
      })
      .filter(e => e.path);

    await prisma.chatFileTree.upsert({
      where: { chatId },
      create: { chatId, treeJson: JSON.stringify(entries), rootLabel: target === '.' ? null : target },
      update: { treeJson: JSON.stringify(entries), rootLabel: target === '.' ? null : target },
    });

    return { ok: true, count: entries.length, entries: entries.slice(0, 200) };
  },
};

listFilesTool.execute = safeExecute('list_files', listFilesTool.execute) as typeof listFilesTool.execute;
