import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

/**
 * ADDED (2026-07-24, "Code Indexing / LSP -- Pyright, TypeScript Language
 * Service, rust-analyzer"): real compiler/type-checker diagnostics
 * instead of the model guessing whether code is correct from reading it.
 *
 * Deliberately implemented as one-shot CLI invocations (`tsc --noEmit`,
 * `pyright --outputjson`, `cargo check --message-format=json`) rather
 * than a persistent LSP JSON-RPC session over stdio -- a bash-driven
 * sandbox tool call is inherently one-shot per call anyway (no
 * long-lived client connection to keep an LSP server's document-sync
 * state warm across calls), and all three of these CLIs are literally
 * the same underlying engine a real LSP server uses for diagnostics
 * (pyright's CLI and pyright-langserver share one type-checking core;
 * `tsc` and typescript-language-server both sit on the same TypeScript
 * Language Service; `cargo check` surfaces the same rustc diagnostics
 * rust-analyzer's LSP surfaces, just without the extra hover/goto-def
 * layer) -- so this gets the real, accurate diagnostic signal without
 * building and maintaining a full LSP client.
 */
type Diagnostic = { file?: string; line?: number; column?: number; severity: string; message: string };

function parseTsc(output: string): Diagnostic[] {
  // Format: path/file.ts(12,5): error TS2345: Argument of type ...
  const diags: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (m) diags.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), severity: m[4], message: `${m[5]}: ${m[6]}` });
  }
  return diags;
}

function parsePyright(output: string): { diags: Diagnostic[]; summary?: unknown } {
  try {
    const parsed = JSON.parse(output);
    const diags: Diagnostic[] = (parsed.generalDiagnostics ?? []).map((d: any) => ({
      file: d.file,
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      severity: d.severity ?? 'error',
      message: d.message,
    }));
    return { diags, summary: parsed.summary };
  } catch {
    return { diags: [] };
  }
}

function parseCargoCheck(output: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.reason !== 'compiler-message' || !msg.message) continue;
      const level = msg.message.level;
      if (level !== 'error' && level !== 'warning') continue;
      const span = (msg.message.spans ?? []).find((s: any) => s.is_primary) ?? msg.message.spans?.[0];
      diags.push({
        file: span?.file_name,
        line: span?.line_start,
        column: span?.column_start,
        severity: level,
        message: msg.message.rendered ?? msg.message.message,
      });
    } catch {
      // Not a JSON line (cargo also prints plain progress text) -- skip it.
    }
  }
  return diags;
}

export const codeDiagnostics = {
  description:
    'Run REAL compiler/type-checker diagnostics for a file or project -- TypeScript (tsc --noEmit, the TypeScript Language ' +
    'Service engine), Python (pyright, the same engine pyright-langserver/Pylance use), or Rust (cargo check, the same rustc ' +
    'diagnostics rust-analyzer surfaces). Use this to actually VERIFY code compiles/type-checks correctly with precise ' +
    'file:line:column error locations, instead of guessing from reading the code.',
  inputSchema: z.object({
    language: z.enum(['typescript', 'python', 'rust']).describe('Which checker to run.'),
    path: z
      .string()
      .optional()
      .describe(
        'File or directory to check (typescript/python only -- omit to check the whole project from the current working directory). ' +
          'Rust always checks the whole cargo project via `cargo check` regardless of this field -- pass the project directory as `path` ' +
          'if it is not the current working directory.'
      ),
  }),
  async execute({ language, path }: { language: 'typescript' | 'python' | 'rust'; path?: string }, ctx: ToolExecCtx) {
    const sandbox = await ctx.getSandbox();
    const target = path && path.trim() ? path.trim() : '.';

    if (language === 'typescript') {
      const cmd = `cd ${JSON.stringify(target === '.' ? '.' : '.')} 2>/dev/null; npx --yes tsc --noEmit --pretty false ${target !== '.' ? JSON.stringify(target) : ''} 2>&1 | head -c 30000`;
      const result = await sandbox.run({ command: cmd });
      const diags = parseTsc(result.stdout);
      return { ok: true, language, errorCount: diags.filter(d => d.severity === 'error').length, warningCount: diags.filter(d => d.severity === 'warning').length, diagnostics: diags.slice(0, 200), truncated: diags.length > 200, raw: diags.length === 0 ? result.stdout.slice(0, 2000) : undefined };
    }

    if (language === 'python') {
      const cmd = `pyright --outputjson ${JSON.stringify(target)} 2>&1 | head -c 30000`;
      const result = await sandbox.run({ command: cmd });
      if (/command not found|not found: pyright/i.test(result.stdout)) {
        return { ok: false, error: 'pyright is not installed in this sandbox -- it should be baked into the bootstrap template; try restart_sandbox to pick up the latest template.' };
      }
      const { diags, summary } = parsePyright(result.stdout);
      return { ok: true, language, errorCount: diags.filter(d => d.severity === 'error').length, warningCount: diags.filter(d => d.severity === 'warning').length, diagnostics: diags.slice(0, 200), truncated: diags.length > 200, summary };
    }

    // rust
    const cmd = `cd ${JSON.stringify(target)} && cargo check --message-format=json 2>&1 | head -c 40000`;
    const result = await sandbox.run({ command: cmd });
    if (/command not found|not found: cargo/i.test(result.stdout)) {
      return { ok: false, error: 'cargo/rust toolchain is not installed in this sandbox -- it should be baked into the bootstrap template; try restart_sandbox to pick up the latest template.' };
    }
    const diags = parseCargoCheck(result.stdout);
    return { ok: true, language, errorCount: diags.filter(d => d.severity === 'error').length, warningCount: diags.filter(d => d.severity === 'warning').length, diagnostics: diags.slice(0, 200), truncated: diags.length > 200, raw: diags.length === 0 ? result.stdout.slice(0, 2000) : undefined };
  },
};

codeDiagnostics.execute = safeExecute('code_diagnostics', codeDiagnostics.execute) as typeof codeDiagnostics.execute;
Object.assign(codeDiagnostics, withAgentTimeout('code_diagnostics', codeDiagnostics, 180_000));
