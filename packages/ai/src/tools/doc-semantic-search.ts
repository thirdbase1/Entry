/**
 * Replaces providers/tools/doc-semantic-search.ts (doc_semantic_search).
 *
 * Now wired to the real embeddings pipeline: `searchEmbeddings()` from
 * `@entry/copilot` performs pgvector cosine-distance similarity search across
 * the user's doc, file, and chat embeddings — exactly the same vector store
 * that `/api/copilot/search` uses for the ChatInput context-attachment picker.
 *
 * The embedding model call itself goes through `copilotProvider.embedding()`
 * inside `searchEmbeddings`'s `embedQuery` helper — no vendor lock-in.
 */
import { z } from 'zod';

import { searchEmbeddings } from '@entry/copilot';

import { toolError } from './error';
import { createTool } from './utils';

export const createDocSemanticSearchTool = (opts?: { userId?: string }) => {
  return createTool(
    { toolName: 'doc_semantic_search' },
    {
      description:
        'Retrieve conceptually related passages by performing vector-based semantic similarity search across embedded documents; use this tool only when exact keyword search fails or the user explicitly needs meaning-level matches (e.g., paraphrases, synonyms, broader concepts, recent documents).',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'The query statement to search for, e.g. "What is the capital of France?"\nWhen querying specific terms or IDs, you should provide the complete string instead of separating it with delimiters.'
          ),
      }),
      execute: async ({ query }: { query: string }) => {
        if (!opts?.userId) {
          return toolError(
            'Doc Semantic Search Not Available',
            'No authenticated user context — this tool requires a userId to scope the search.'
          );
        }
        try {
          const results = await searchEmbeddings(opts.userId, query, 5);
          return {
            query,
            results: results.map(r => ({
              targetId: r.targetId,
              targetType: r.targetType,
              chunk: r.chunk,
              content: r.content,
              score: 1 - r.distance,
            })),
          };
        } catch (err: any) {
          return toolError('Doc Semantic Search Failed', err.message ?? String(err));
        }
      },
    }
  );
};
