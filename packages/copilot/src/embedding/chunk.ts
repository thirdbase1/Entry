/**
 * Replaces `getFileChunks()` in embedding/types.ts, which called Entry's
 * Rust-native `parseDoc()` binding (rich multi-format parsing: PDF, docx,
 * etc. — a native addon that has no equivalent in this Vercel/Next.js
 * target). Real, documented scope cut: this port only extracts plain text.
 * Docs here are already always plain text/markdown (see packages/copilot's
 * AiUserDocs model — content is a plain String column, no rich format).
 * Files are handled the same way in service.ts's `extractText()` — only
 * text-shaped mimetypes get chunked/embedded; binary formats (PDF, docx,
 * images) are stored as blobs (already working via Vercel Blob) but are
 * skipped for embedding rather than silently mis-parsed as raw bytes.
 */
export interface Chunk {
  index: number;
  content: string;
}

const CHARS_PER_CHUNK = 1200;
const BATCH_SIZE = 128; // mirrors the original's `chunks.push(input.slice(i, i + 128))` batching

/** Splits text into ~CHARS_PER_CHUNK-sized chunks on paragraph boundaries where possible. */
export function chunkText(text: string): Chunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) {
      chunks.push({ index: chunks.length, content: buffer.trim() });
    }
    buffer = '';
  };

  for (const para of paragraphs) {
    if (para.length > CHARS_PER_CHUNK) {
      // paragraph itself too big — hard-split it
      flush();
      for (let i = 0; i < para.length; i += CHARS_PER_CHUNK) {
        chunks.push({ index: chunks.length, content: para.slice(i, i + CHARS_PER_CHUNK).trim() });
      }
      continue;
    }
    if (buffer.length + para.length + 2 > CHARS_PER_CHUNK) {
      flush();
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }
  flush();

  return chunks;
}

/** Batches chunks into groups of BATCH_SIZE, mirroring the original's job structure (one embedding call per batch). */
export function batchChunks(chunks: Chunk[]): Chunk[][] {
  const batches: Chunk[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    batches.push(chunks.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

/** Plain-text-only mimetypes eligible for embedding — everything else (PDF/docx/images/etc.) is stored but not embedded. */
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml'];
const TEXT_MIME_EXACT = new Set(['application/x-markdown']);

export function isEmbeddableText(mimeType: string): boolean {
  return TEXT_MIME_EXACT.has(mimeType) || TEXT_MIME_PREFIXES.some(p => mimeType.startsWith(p));
}
