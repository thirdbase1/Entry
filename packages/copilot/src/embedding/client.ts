/**
 * Replaces embedding/client.ts's `ProductionEmbeddingClient`. The original
 * routed through Entry's own `CopilotProviderFactory` abstraction
 * (multi-provider config, scenario overrides) to call `gemini-embedding-001`
 * with `dimensions: 1024`. This port goes straight through the AI Gateway
 * (`@ai-sdk/gateway`'s `gateway.textEmbeddingModel()`, confirmed a real
 * export) using the `ai` package's `embedMany` (confirmed real export,
 * v7.0.16) — no separate provider-factory layer needed since the Gateway
 * already is the multi-provider abstraction for this whole migration.
 *
 * Model: `openai/text-embedding-3-small`, requested at 1024 dimensions via
 * `providerOptions.openai.dimensions` (OpenAI's own API supports variable
 * output dimensionality on the v3 embedding models; AI SDK forwards
 * providerOptions 1:1 to the underlying provider). Chosen specifically to
 * match `EMBEDDING_DIMENSIONS = 1024`, which is also what
 * schema.prisma's `vector(1024)` columns were already sized for in Phase 2
 * — NOT rechecked live against a real API call in this sandbox (no
 * AI_GATEWAY_API_KEY here), so `embedBatch()` asserts the returned vector
 * length at runtime and throws a clear, loud error rather than silently
 * writing a wrong-sized vector if that assumption turns out wrong at
 * deploy time.
 */
import { embedMany } from 'ai';
import { gateway } from '@ai-sdk/gateway';

export const EMBEDDING_DIMENSIONS = 1024;
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export interface EmbeddingResult {
  index: number;
  embedding: number[];
  content: string;
}

export async function embedBatch(inputs: string[]): Promise<EmbeddingResult[]> {
  if (!inputs.length) return [];

  const model = gateway.textEmbeddingModel(EMBEDDING_MODEL);
  const { embeddings } = await embedMany({
    model,
    values: inputs,
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
  });

  return embeddings.map((embedding, index) => {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding model ${EMBEDDING_MODEL} returned ${embedding.length}-dim vectors, expected ${EMBEDDING_DIMENSIONS} ` +
          `(schema.prisma's vector(${EMBEDDING_DIMENSIONS}) columns won't accept this — check providerOptions/model choice).`
      );
    }
    return { index, embedding, content: inputs[index] };
  });
}

export async function embedQuery(query: string): Promise<number[]> {
  const [result] = await embedBatch([query]);
  return result.embedding;
}
