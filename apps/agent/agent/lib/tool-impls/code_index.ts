import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

/**
 * ADDED (2026-07-24, "Code Indexing / LSP -- Tree-Sitter"): structural
 * symbol outline for a source file (functions, classes, methods,
 * interfaces, structs, etc. with real start/end line numbers), backed by
 * `tree_sitter_languages` (Python, baked into the sandbox bootstrap --
 * see sandbox/sandbox.ts). This is the "give me the map of this file
 * without reading every line" tool: far cheaper than a full read_file for
 * "what's defined in here" style questions on a large file, and a
 * building block for future refactor/navigation tools that need real AST
 * positions rather than guessing from raw text.
 *
 * Deliberately implemented via tree-sitter (a real incremental parser,
 * not a regex heuristic) so results are accurate for real code -- a
 * regex-based "find function definitions" breaks constantly on nested
 * scopes, multi-line signatures, decorators, generics, etc.
 */
const LANG_BY_EXT: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
};

const SUPPORTED_LANGS = Array.from(new Set(Object.values(LANG_BY_EXT))).sort();

// Kept in a small Python heredoc rather than a baked script file so this
// tool's logic versions alongside the TypeScript that calls it (one file
// to review/change, no separate baked-script drift risk).
const PY_SCRIPT = `
import sys, json, os

path = sys.argv[1]
lang = sys.argv[2]

try:
    from tree_sitter_languages import get_parser
except Exception as e:
    print(json.dumps({"ok": False, "error": f"tree_sitter_languages not available: {e}"}))
    sys.exit(0)

try:
    parser = get_parser(lang)
except Exception as e:
    print(json.dumps({"ok": False, "error": f"no tree-sitter grammar for language '{lang}': {e}"}))
    sys.exit(0)

try:
    with open(path, "rb") as f:
        src = f.read()
except Exception as e:
    print(json.dumps({"ok": False, "error": f"could not read {path}: {e}"}))
    sys.exit(0)

tree = parser.parse(src)

SYMBOL_NODE_TYPES = {
    "python": {"function_definition", "class_definition"},
    "typescript": {"function_declaration", "class_declaration", "method_definition", "interface_declaration", "type_alias_declaration"},
    "tsx": {"function_declaration", "class_declaration", "method_definition", "interface_declaration", "type_alias_declaration"},
    "javascript": {"function_declaration", "class_declaration", "method_definition"},
    "rust": {"function_item", "struct_item", "impl_item", "trait_item", "enum_item", "mod_item"},
    "go": {"function_declaration", "method_declaration", "type_declaration"},
    "java": {"class_declaration", "method_declaration", "interface_declaration"},
    "ruby": {"method", "class", "module"},
    "c": {"function_definition", "struct_specifier"},
    "cpp": {"function_definition", "struct_specifier", "class_specifier"},
}
wanted = SYMBOL_NODE_TYPES.get(lang, set())

def name_of(node):
    for child in node.children:
        if child.type in ("identifier", "type_identifier", "property_identifier", "field_identifier"):
            return src[child.start_byte:child.end_byte].decode("utf-8", "replace")
    return None

results = []

def walk(node):
    if node.type in wanted:
        results.append({
            "type": node.type,
            "name": name_of(node),
            "start_line": node.start_point[0] + 1,
            "end_line": node.end_point[0] + 1,
        })
    for child in node.children:
        walk(child)

walk(tree.root_node)
print(json.dumps({"ok": True, "language": lang, "symbol_count": len(results), "symbols": results[:500]}))
`.trim();

export const codeIndex = {
  description:
    'Get a structural outline of a source file -- every top-level function/class/method/interface/struct with its exact ' +
    'start/end line numbers -- via real tree-sitter AST parsing (not a regex guess). Use this to understand what a large file ' +
    'contains before deciding what to read_file/edit_file, instead of reading the whole thing. Supports: ' +
    `${SUPPORTED_LANGS.join(', ')}.`,
  inputSchema: z.object({
    path: z.string().min(1).describe('Relative path (from the project root) of the file to index.'),
    language: z
      .enum(SUPPORTED_LANGS as [string, ...string[]])
      .optional()
      .describe('Language grammar to use. Omit to auto-detect from the file extension.'),
  }),
  async execute({ path, language }: { path: string; language?: string }, ctx: ToolExecCtx) {
    const sandbox = await ctx.getSandbox();
    const ext = path.slice(path.lastIndexOf('.'));
    const lang = language ?? LANG_BY_EXT[ext];
    if (!lang) {
      return { ok: false, error: `Could not auto-detect a language for "${path}" (extension "${ext}"). Pass \`language\` explicitly -- supported: ${SUPPORTED_LANGS.join(', ')}.` };
    }

    const b64Script = Buffer.from(PY_SCRIPT, 'utf8').toString('base64');
    const cmd = `printf '%s' '${b64Script}' | base64 -d > /tmp/.entry_code_index.py && python3 /tmp/.entry_code_index.py ${JSON.stringify(path)} ${JSON.stringify(lang)}`;
    const result = await sandbox.run({ command: cmd });
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { ok: false, error: `code_index failed (exit ${result.exitCode}): ${result.stderr.slice(0, 800)}` };
    }
    try {
      const parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
      return parsed;
    } catch {
      return { ok: false, error: `Could not parse code_index output: ${result.stdout.slice(0, 500)}` };
    }
  },
};

codeIndex.execute = safeExecute('code_index', codeIndex.execute) as typeof codeIndex.execute;
Object.assign(codeIndex, withAgentTimeout('code_index', codeIndex, 60_000));
