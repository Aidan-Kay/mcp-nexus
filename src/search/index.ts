/** Search engine — dispatches lexical/semantic search with fallback */

import { logger } from "../logger.js";
import type { NexusIndex } from "../types.js";
import { hybridSearch, round2 } from "./hybrid-search.js";
import { lexicalSearch } from "./lexical-search.js";
import { EmbeddingIndex } from "./semantic-search.js";
import type { EmbeddingProvider, ScoredResult, SearchConfig, SearchResult, SearchType, ToolPredicate } from "./types.js";

/** What /health reports about search: whether the configured strategy is the one running. */
export interface SearchStatus {
  /** The strategy in the config. */
  configured: SearchType;
  /**
   * `ok` — running as configured. `unavailable` — the embedding provider never came up,
   * so every search is lexical. `failing` — it came up, but the most recent query
   * that needed it failed and was answered lexically.
   */
  semantic: "ok" | "unavailable" | "failing" | "not-configured";
  /** Why, when semantic is not ok. */
  error?: string;
  /** When the most recent fallback to lexical happened (ISO). */
  lastFallbackAt?: string;
}

/**
 * Unified search engine.
 *
 * - When type === "lexical": uses word-prefix scoring only.
 * - When type === "hybrid": fuses semantic and lexical rankings. If the embedding
 *   provider fails (network error, service down), falls back to lexical search and
 *   sets fellBackToLexical: true in the result.
 * - When type === "semantic": uses cosine similarity. If the embedding
 *   provider fails (network error, service down), falls back to lexical
 *   search and sets fellBackToLexical: true in the result.
 *
 * A fallback used to be visible only on the search result that suffered it, which
 * the agent reads and the operator never sees. The engine now remembers it, and
 * /health reports it.
 *
 * Never returns the full tool list as a fallback. If search returns zero
 * results, the LLM must retry with a different query.
 */
export class SearchEngine {
  private config: SearchConfig;
  private index: NexusIndex;
  private provider?: EmbeddingProvider;
  private embeddingIndex?: EmbeddingIndex;
  /** Set when the provider failed to start, so no query will ever reach it. */
  private unavailableReason?: string;
  /** The most recent query-time failure, cleared by the next query that succeeds. */
  private lastFailure?: { at: number; error: string };
  private lastFallbackAt?: number;

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

  /** Record that the provider never started, for /health. Searches fall back regardless. */
  markUnavailable(reason: string): void {
    this.unavailableReason = reason;
  }

  status(): SearchStatus {
    const configured = this.config.type;
    const lastFallbackAt = this.lastFallbackAt ? new Date(this.lastFallbackAt).toISOString() : undefined;
    if (configured === "lexical") return { configured, semantic: "not-configured" };
    if (this.unavailableReason || !this.provider || !this.embeddingIndex) {
      return { configured, semantic: "unavailable", error: this.unavailableReason ?? "no embedding provider", lastFallbackAt };
    }
    if (this.lastFailure) return { configured, semantic: "failing", error: this.lastFailure.error, lastFallbackAt };
    return { configured, semantic: "ok", lastFallbackAt };
  }

  /**
   * Search the index. `visible` narrows it to the tools one client may see, before
   * ranking and truncation, so a client's results are never padded out by — or cut
   * short for — tools it could not call.
   */
  async search(query: string, serviceId?: string, visible?: ToolPredicate): Promise<SearchResult> {
    const max = this.config.maxResults;
    const minSimilarity = this.config.semantic?.minSimilarity ?? 0;

    if (this.config.type === "lexical") {
      return this.runLexical(query, serviceId, max, "lexical", false, visible);
    }

    if (!this.provider || !this.embeddingIndex) {
      logger.warn(`${this.config.type} search configured but provider/index not available — falling back to lexical`);
      return this.fallBack(query, serviceId, max, visible);
    }

    let queryEmbedding: Float32Array;
    try {
      queryEmbedding = await this.provider.embed(query);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`${this.config.type} search failed — falling back to lexical: ${error}`);
      this.lastFailure = { at: Date.now(), error };
      return this.fallBack(query, serviceId, max, visible);
    }
    this.lastFailure = undefined;

    if (this.config.type === "hybrid") {
      return hybridSearch({
        query,
        tools: this.index.tools,
        embeddingIndex: this.embeddingIndex,
        queryEmbedding,
        minSimilarity,
        maxResults: max,
        serviceId,
        visible,
      });
    }

    const scored = this.embeddingIndex.search(queryEmbedding, serviceId);
    const result = this.formatResult(query, visible ? scored.filter((s) => visible(s.name)) : scored, max, "semantic", false, minSimilarity);
    return { ...result, minSimilarity };
  }

  private fallBack(query: string, serviceId: string | undefined, max: number, visible?: ToolPredicate): SearchResult {
    this.lastFallbackAt = Date.now();
    return this.runLexical(query, serviceId, max, this.config.type, true, visible);
  }

  private runLexical(
    query: string,
    serviceId: string | undefined,
    max: number,
    strategy: SearchType,
    fellBack: boolean,
    visible?: ToolPredicate,
  ): SearchResult {
    const scored = lexicalSearch(query, this.index.tools, serviceId);
    return this.formatResult(query, visible ? scored.filter((s) => visible(s.name)) : scored, max, strategy, fellBack);
  }

  private formatResult(
    query: string,
    scored: ScoredResult[],
    max: number,
    strategy: SearchType,
    fellBack: boolean,
    matchFloor?: number,
  ): SearchResult {
    // The floor bounds both the count and the results: a tool below it is not a match,
    // so it is neither counted nor returned, and a query nothing resembles comes back
    // empty — which the caller reads as "rephrase" — rather than as five weak guesses.
    // Its presence also says the scores are similarities, worth showing to the caller.
    const matches = matchFloor === undefined ? scored : scored.filter((s) => s.score >= matchFloor);
    const truncated = matches.length > max;
    const results = matches
      .slice(0, max)
      .map(({ name, serviceId, score }) => ({ name, serviceId, ...(matchFloor !== undefined ? { similarity: round2(score) } : {}) }));
    const totalMatches = matches.length;

    return {
      query,
      results,
      totalMatches,
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
  if ((config.type !== "semantic" && config.type !== "hybrid") || !config.semantic) return undefined;

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
