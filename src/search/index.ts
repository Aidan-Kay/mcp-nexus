/** Search engine — dispatches lexical/semantic search with fallback */

import { logger } from "../logger.js";
import type { NexusIndex } from "../types.js";
import { lexicalSearch } from "./lexical-search.js";
import { EmbeddingIndex } from "./semantic-search.js";
import type { EmbeddingProvider, ScoredResult, SearchConfig, SearchResult } from "./types.js";

/**
 * Unified search engine.
 *
 * - When type === "lexical": uses substring scoring only.
 * - When type === "semantic": uses cosine similarity. If the embedding
 *   provider fails (network error, service down), falls back to lexical
 *   search and sets fellBackToLexical: true in the result.
 *
 * Never returns the full tool list as a fallback. If search returns zero
 * results, the LLM must retry with a different query.
 */
export class SearchEngine {
  private config: SearchConfig;
  private index: NexusIndex;
  private provider?: EmbeddingProvider;
  private embeddingIndex?: EmbeddingIndex;

  constructor(config: SearchConfig, index: NexusIndex, provider?: EmbeddingProvider) {
    this.config = config;
    this.index = index;
    this.provider = provider;
  }

  /** Set the embedding index (called after indexing completes) */
  setEmbeddingIndex(embeddingIndex: EmbeddingIndex): void {
    this.embeddingIndex = embeddingIndex;
  }

  /** Get the embedding index (used by recovery to generate embeddings for recovered tools) */
  getEmbeddingIndex(): EmbeddingIndex | undefined {
    return this.embeddingIndex;
  }

  /** Get the embedding provider (used by recovery) */
  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return this.provider;
  }

  async search(query: string, serviceId?: string): Promise<SearchResult> {
    const max = this.config.maxResults;

    if (this.config.type === "lexical") {
      return this.runLexical(query, serviceId, max, "lexical", false);
    }

    // Semantic search
    if (!this.provider || !this.embeddingIndex) {
      logger.warn("Semantic search configured but provider/index not available — falling back to lexical");
      return this.runLexical(query, serviceId, max, "semantic", true);
    }

    try {
      const queryEmbedding = await this.provider.embed(query);
      const scored = this.embeddingIndex.search(queryEmbedding, serviceId);
      return this.formatResult(query, scored, max, "semantic", false);
    } catch (err) {
      logger.warn(`Semantic search failed — falling back to lexical: ${err instanceof Error ? err.message : String(err)}`);
      return this.runLexical(query, serviceId, max, "semantic", true);
    }
  }

  private runLexical(
    query: string,
    serviceId: string | undefined,
    max: number,
    strategy: "lexical" | "semantic",
    fellBack: boolean,
  ): SearchResult {
    const scored = lexicalSearch(query, this.index.tools, serviceId);
    return this.formatResult(query, scored, max, strategy, fellBack);
  }

  private formatResult(
    query: string,
    scored: ScoredResult[],
    max: number,
    strategy: "lexical" | "semantic",
    fellBack: boolean,
  ): SearchResult {
    const truncated = scored.length > max;
    const results = scored.slice(0, max).map(({ name, serviceId }) => ({ name, serviceId }));

    return {
      query,
      results,
      totalMatches: scored.length,
      truncated: truncated || undefined,
      strategy,
      fellBackToLexical: fellBack || undefined,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an embedding provider from config.
 * Returns undefined if semantic search is not configured.
 */
export async function createEmbeddingProvider(config: SearchConfig): Promise<EmbeddingProvider | undefined> {
  if (config.type !== "semantic" || !config.semantic) return undefined;

  const { provider: providerType, model, baseUrl, apiKeyEnv, modelCachePath } = config.semantic;

  let provider: EmbeddingProvider;

  switch (providerType) {
    case "built-in": {
      const { BuiltinEmbeddingProvider } = await import("./providers/builtin.js");
      provider = new BuiltinEmbeddingProvider(model, modelCachePath);
      break;
    }
    case "ollama": {
      const { OllamaEmbeddingProvider } = await import("./providers/ollama.js");
      if (!baseUrl) throw new Error("baseUrl is required for ollama embedding provider");
      provider = new OllamaEmbeddingProvider(baseUrl, model);
      break;
    }
    case "openai-compatible": {
      const { OpenAIEmbeddingProvider } = await import("./providers/openai.js");
      if (!baseUrl) throw new Error("baseUrl is required for openai-compatible embedding provider");
      if (!apiKeyEnv) throw new Error("apiKeyEnv is required for openai-compatible embedding provider");
      const apiKey = process.env[apiKeyEnv] ?? "";
      if (!apiKey) throw new Error(`Environment variable ${apiKeyEnv} is not set`);
      provider = new OpenAIEmbeddingProvider(baseUrl, apiKey, model);
      break;
    }
    default:
      throw new Error(`Unknown embedding provider: ${providerType}`);
  }

  await provider.init();

  // Create embedding index with the provider's dimensions
  const { EmbeddingIndex } = await import("./semantic-search.js");
  const embeddingIndex = new EmbeddingIndex(provider.dimensions);

  // Return both via a wrapper — the caller will use them separately
  // We use a trick: attach the embedding index to the provider for now
  // and extract it in the caller. This avoids changing the interface.
  (provider as EmbeddingProvider & { _embeddingIndex?: EmbeddingIndex })._embeddingIndex = embeddingIndex;

  return provider;
}

/**
 * Extract the embedding index created alongside the provider.
 * This is a workaround for not changing the EmbeddingProvider interface.
 */
export function getEmbeddingIndex(provider: EmbeddingProvider): EmbeddingIndex | undefined {
  return (provider as EmbeddingProvider & { _embeddingIndex?: EmbeddingIndex })._embeddingIndex;
}

/**
 * Generate embeddings for all tools in the index.
 * Called after indexing completes, before the server starts.
 */
export async function generateToolEmbeddings(
  index: NexusIndex,
  provider: EmbeddingProvider,
  embeddingIndex: EmbeddingIndex,
  batchSize: number,
): Promise<void> {
  await embeddingIndex.generateEmbeddings(index.tools, provider, batchSize);
}
