// Embedding generation & batching
import type OpenAI from "openai";
import { withRetry } from "../utils/retry.js";

export interface EmbeddingResult {
  vectors: number[][];
  totalTokens: number;
}

export const generateEmbeddings = async (
  openai: OpenAI,
  childTexts: string[],
  source: string,
  url: string,
  vectorDimensions: number,
  retryAttempts: number,
  retryBaseDelayMs: number,
): Promise<EmbeddingResult> => {
  const EMBED_BATCH = 100;
  const allVectors: number[][] = [];
  let totalTokens = 0;

  for (let b = 0; b < childTexts.length; b += EMBED_BATCH) {
    const batch = childTexts.slice(b, b + EMBED_BATCH);
    const enriched = batch.map((c) => `[Source: ${source}]\n${c}`);
    const embeddingRes = await withRetry(
      `embed:${url}:batch:${b}`,
      () =>
        openai.embeddings.create({
          model: "text-embedding-3-large",
          input: enriched,
          dimensions: vectorDimensions,
          encoding_format: "float",
        }),
      retryAttempts,
      retryBaseDelayMs,
    );
    for (const item of embeddingRes.data) {
      allVectors.push(item.embedding);
    }
    const batchTokens = embeddingRes.usage?.total_tokens ?? 0;
    totalTokens += batchTokens;
    console.log(
      `  Embedded child batch ${Math.floor(b / EMBED_BATCH) + 1}/${Math.ceil(childTexts.length / EMBED_BATCH)} (${batch.length} chunks, ${batchTokens} tokens)`,
    );
  }

  return { vectors: allVectors, totalTokens };
};
