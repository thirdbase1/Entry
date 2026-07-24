import { z } from 'zod';
import { embedMany } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { sandboxWriteFile, sandboxReadFile } from './sandbox-file-io.js';

/**
 * ADDED (2026-07-24, "Search / Embeddings -- Qdrant, LanceDB"): semantic
 * ("meaning", not just exact-text) code search over the project, so
 * "where do we handle refund logic" finds the right code even without
 * the literal word "refund" appearing verbatim (code_search/ripgrep's
 * job, kept separate -- see that file).
 *
 * DELIBERATELY NOT a real LanceDB/Qdrant instance: both are genuinely
 * good tools, but both need either a running server process (Qdrant) or
 * a native/WASM binary dependency (LanceDB's Node bindings) pulled into
 * eve's Rolldown bundler -- and this exact codebase has ALREADY hit a
 * real, documented production build failure from precisely that class of
 * problem (@prisma/client's WASM query-compiler forcing a second bundle
 * chunk, see agent.ts's `build.externalDependencies` comment: "Expected
 * one bundled authored module"). Adding another native/WASM dependency
 * without a live eve build to verify against is the same risk again for
 * a feature that doesn't strictly need it: a per-project code index is
 * small enough (typically a few hundred chunks) that a plain JSON file +
 * brute-force cosine similarity in JS is genuinely fast enough, and it
 * needs zero new infra, zero new native deps, and reuses the exact same
 * embedding model + sandbox file I/O every other piece of this codebase
 * already goes through (packages/copilot/src/embedding/client.ts's own
 * `gateway.textEmbeddingModel('openai/text-embedding-3-small')` +
 * `embedMany` pattern, reimplemented directly here rather than importing
 * that package -- @entry/copilot transitively pulls in @entry/db/Prisma,
 * which is exactly the dependency chain that caused the build failure
 * this comment references in the first place).
 *
 * Index storage: one JSON file per named index under `.entry-embeddings/`
 * in the SAME sandbox the project lives in (via the shared
 * sandboxWriteFile/sandboxReadFile helpers) -- so it persists with the
 * project the same way any other sandbox file does, no separate database
 * or server needed.
 */
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1024;
const MAX_CHUNKS = 400;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const EMBED_BATCH_SIZE = 96;

const EXCLUDED_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '__pycache__', '.cache', '.entry-embeddings', '.agent-channels', 'target', 'vendor'];

// Python walker: finds text-ish source files under `root`, chunks each into
// ~CHUNK_LINES-line pieces with overlap, caps total chunks at MAX_CHUNKS.
// Kept as a heredoc (like code_index.ts) so chunking logic versions
// alongside the TypeScript that calls it.
function buildChunkScript(root: string, exts: string[]): string {
  const extList = exts.map(e => JSON.stringify(e)).join(', ');
  const excludeList = EXCLUDED_DIRS.map(d => JSON.stringify(d)).join(', ');
  return `
import os, json

ROOT = ${JSON.stringify(root)}
EXTS = [${extList}]
EXCLUDED = {${excludeList}}
MAX_CHUNKS = ${MAX_CHUNKS}
CHUNK_LINES = ${CHUNK_LINES}
OVERLAP = ${CHUNK_OVERLAP}

chunks = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDED and not d.startswith(".")]
    for fn in filenames:
        if len(chunks) >= MAX_CHUNKS:
            break
        if EXTS and not any(fn.endswith(e) for e in EXTS):
            continue
        path = os.path.join(dirpath, fn)
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.read().split("\\n")
        except Exception:
            continue
        if len(lines) == 0 or len("\\n".join(lines)) > 200000:
            continue
        i = 0
        while i < len(lines) and len(chunks) < MAX_CHUNKS:
            piece = lines[i : i + CHUNK_LINES]
            text = "\\n".join(piece).strip()
            if text:
                chunks.append({"file": rel, "start_line": i + 1, "end_line": min(i + len(piece), len(lines)), "text": text[:4000]})
            i += CHUNK_LINES - OVERLAP
    if len(chunks) >= MAX_CHUNKS:
        break

print(json.dumps({"chunks": chunks, "truncated": len(chunks) >= MAX_CHUNKS}))
`.trim();
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type IndexedChunk = { file: string; start_line: number; end_line: number; text: string; embedding: number[] };

async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = gateway.textEmbeddingModel(EMBEDDING_MODEL);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const { embeddings } = await embedMany({ model, values: batch, providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } } });
    out.push(...embeddings);
  }
  return out;
}

function indexPath(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'default';
  return `.entry-embeddings/${safe}.json`;
}

export const codeEmbedSearch = {
  description:
    'Semantic ("by meaning", not exact text) code search over the project -- finds relevant code for a natural-language query even ' +
    'when it does not contain the literal words used (complements code_search/ripgrep, which only matches exact text/regex). Two ' +
    'actions: `index` (chunk + embed files under a path into a named index -- do this once per area of the project, or after a big ' +
    'change) then `search` (embed a query and return the most semantically similar chunks). Costs a small amount of embedding API ' +
    'usage per `index` call -- do not re-index on every call, only when the indexed code has meaningfully changed.',
  inputSchema: z.object({
    action: z.enum(['index', 'search']),
    index_name: z.string().optional().describe('Name for this index (default "default") -- use different names for different areas/projects if useful.'),
    path: z.string().optional().describe('index only: relative directory to index (default "."). Skips node_modules/.git/build output automatically.'),
    extensions: z
      .array(z.string())
      .optional()
      .describe('index only: file extensions to include, e.g. [".ts", ".tsx", ".py"]. Omit to include common source extensions by default.'),
    query: z.string().optional().describe('search only: natural-language query to search for.'),
    top_k: z.number().int().min(1).max(30).optional().describe('search only: how many results to return (default 8).'),
  }),
  async execute(
    {
      action,
      index_name,
      path,
      extensions,
      query,
      top_k,
    }: { action: 'index' | 'search'; index_name?: string; path?: string; extensions?: string[]; query?: string; top_k?: number },
    ctx: ToolExecCtx
  ) {
    const name = index_name ?? 'default';
    const file = indexPath(name);

    if (action === 'index') {
      const root = path && path.trim() ? path.trim() : '.';
      const exts = extensions && extensions.length ? extensions : ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.md'];
      const sandbox = await ctx.getSandbox();
      const script = buildChunkScript(root, exts);
      const b64 = Buffer.from(script, 'utf8').toString('base64');
      const cmd = `printf '%s' '${b64}' | base64 -d > /tmp/.entry_chunker.py && python3 /tmp/.entry_chunker.py`;
      const result = await sandbox.run({ command: cmd });
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return { ok: false, error: `Chunking failed (exit ${result.exitCode}): ${result.stderr.slice(0, 800)}` };
      }
      let parsed: { chunks: { file: string; start_line: number; end_line: number; text: string }[]; truncated: boolean };
      try {
        parsed = JSON.parse(result.stdout.trim());
      } catch {
        return { ok: false, error: `Could not parse chunker output: ${result.stdout.slice(0, 500)}` };
      }
      if (parsed.chunks.length === 0) {
        return { ok: false, error: `No files matched under "${root}" with extensions ${exts.join(', ')}.` };
      }

      const embeddings = await embedTexts(parsed.chunks.map(c => c.text));
      const indexed: IndexedChunk[] = parsed.chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));

      const w = await sandboxWriteFile(ctx, file, JSON.stringify(indexed), { encoding: 'utf8' });
      if (!w.ok) return { ok: false, error: w.error };
      return { ok: true, index_name: name, chunks_indexed: indexed.length, truncated: parsed.truncated };
    }

    // search
    if (!query || !query.trim()) return { ok: false, error: 'search requires `query`.' };
    const r = await sandboxReadFile(ctx, file);
    if (!r.ok) return { ok: false, error: `Index "${name}" does not exist yet -- run action "index" first (e.g. on "." or a specific subdirectory).` };
    let indexed: IndexedChunk[];
    try {
      indexed = JSON.parse(r.content);
    } catch {
      return { ok: false, error: `Index "${name}" is corrupted -- re-run action "index" to rebuild it.` };
    }

    const [queryEmbedding] = await embedTexts([query]);
    const scored = indexed
      .map(c => ({ file: c.file, start_line: c.start_line, end_line: c.end_line, snippet: c.text.slice(0, 800), score: cosineSim(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, top_k ?? 8);

    return { ok: true, index_name: name, results: scored };
  },
};

codeEmbedSearch.execute = safeExecute('code_embed_search', codeEmbedSearch.execute) as typeof codeEmbedSearch.execute;
Object.assign(codeEmbedSearch, withAgentTimeout('code_embed_search', codeEmbedSearch, 240_000));
