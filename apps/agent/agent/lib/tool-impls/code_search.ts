import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

/**
 * ADDED (2026-07-24, "Search / Embeddings -- BM25 / Ripgrep"): fast,
 * exact/regex text search across the project, backed by ripgrep (`rg`,
 * baked into the sandbox bootstrap -- see sandbox/sandbox.ts). Every
 * coding tool in this file already has `bash`, which technically CAN run
 * `grep`/`rg` itself -- this exists as a first-class tool anyway because
 * (a) the model reliably reaches for a slow/naive `grep -r` via bash
 * instead of ripgrep's far faster, .gitignore-aware defaults unless it's
 * offered as its own clearly-described tool, and (b) a dedicated tool can
 * normalize output into structured {file, line, text} matches instead of
 * raw terminal text the model has to re-parse itself, saving tokens on
 * both sides of the call.
 */
const MAX_MATCHES = 300;

export const codeSearch = {
  description:
    'Fast exact/regex text search across the project (ripgrep -- honors .gitignore automatically, skips node_modules/.git by ' +
    'default). Use this for "find every place X is defined/used/imported" style questions instead of a slow manual `grep -r` via ' +
    'bash. Returns structured file:line matches, capped at 300 results across the whole search.',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Regex (Rust-regex syntax, ripgrep default) or plain text to search for.'),
    path: z.string().optional().describe('Relative directory or file to scope the search to. Omit to search the whole project.'),
    glob: z.string().optional().describe('Optional glob to restrict which files are searched, e.g. "*.ts" or "!*.test.ts". Repeatable patterns should be space-separated.'),
    case_sensitive: z.boolean().optional().describe('Defaults to false (case-insensitive search).'),
    fixed_string: z.boolean().optional().describe('Treat `pattern` as a literal string rather than a regex -- use for patterns containing regex-special characters.'),
  }),
  async execute(
    {
      pattern,
      path,
      glob,
      case_sensitive,
      fixed_string,
    }: { pattern: string; path?: string; glob?: string; case_sensitive?: boolean; fixed_string?: boolean },
    ctx: ToolExecCtx
  ) {
    const sandbox = await ctx.getSandbox();
    const target = path && path.trim() ? path.trim().replace(/^\/+/, '') : '.';
    const globFlags = (glob ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(g => `-g ${JSON.stringify(g)}`)
      .join(' ');
    const flags = ['--line-number', '--no-heading', '--color=never', case_sensitive ? '' : '-i', fixed_string ? '-F' : '', globFlags, '--max-count=50']
      .filter(Boolean)
      .join(' ');
    const cmd = `rg ${flags} -- ${JSON.stringify(pattern)} ${JSON.stringify(target)} 2>&1 | head -n ${MAX_MATCHES}`;
    const result = await sandbox.run({ command: cmd });
    // ripgrep exits 1 (not an error) when there are simply no matches; only treat other nonzero codes as real failures.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      if (/command not found|not found: rg/i.test(result.stdout + result.stderr)) {
        return { ok: false, error: 'ripgrep (rg) is not installed in this sandbox -- it should be baked into the bootstrap template; try restart_sandbox to pick up the latest template.' };
      }
      return { ok: false, error: `ripgrep failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 500)}` };
    }
    const lines = result.stdout.split('\n').filter(Boolean);
    const matches = lines.map(line => {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) return { raw: line.slice(0, 500) };
      return { file: m[1], line: Number(m[2]), text: m[3].slice(0, 500) };
    });
    return { ok: true, count: matches.length, truncated: matches.length >= MAX_MATCHES, matches };
  },
};

codeSearch.execute = safeExecute('code_search', codeSearch.execute) as typeof codeSearch.execute;
Object.assign(codeSearch, withAgentTimeout('code_search', codeSearch, 60_000));
