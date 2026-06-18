/** Types for the search module */

import type { IndexedTool } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export type SearchType = "lexical" | "semantic";
export type EmbeddingProviderType = "built-in" | "ollama" | "openai-compatible";

export interface SearchConfig {
  /** Search algorithm: lexical (default) or semantic */
  type: SearchType;
  /** Max results returned by search_tools */
  maxResults: number;
  /** Semantic search settings (only used when type === "semantic") */
  semantic?: SemanticSearchConfig;
}

export interface SemanticSearchConfig {
  provider: EmbeddingProviderType;
  /** Model name (defaults vary by provider) */
  model?: string;
  /** Base URL for ollama / openai-compatible providers */
  baseUrl?: string;
  /** Env var name containing the API key (openai-compatible only) */
  apiKeyEnv?: string;
  /** Batch size for embedding generation during indexing */
  batchSize: number;
  /** Where to store the downloaded model (built-in provider only) */
  modelCachePath?: string;
}

// ─── Embedding Provider Interface ────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Dimensionality of the embedding vectors */
  readonly dimensions: number;
  /** Initialize the provider (load model, test connection, etc.) */
  init(): Promise<void>;
  /** Embed a single text (used for search queries) */
  embed(text: string): Promise<Float32Array>;
  /** Embed multiple texts in batches (used for indexing) */
  embedBatch(texts: string[], batchSize: number): Promise<Float32Array[]>;
}

// ─── Search Results ──────────────────────────────────────────────────────────

export interface ScoredResult {
  name: string;
  serviceId: string;
  score: number;
}

export interface SearchResult {
  query: string;
  results: Array<{ name: string; serviceId: string }>;
  totalMatches: number;
  truncated?: boolean;
  /** Which search strategy was used (for logging/debugging) */
  strategy: SearchType;
  /** True if semantic search failed and fell back to lexical */
  fellBackToLexical?: boolean;
}

// ─── Tool Text Representation ────────────────────────────────────────────────

/**
 * Convert a tool definition into a text representation for embedding.
 * Combines the tool name, description, and parameter information.
 */
export function toolToText(tool: IndexedTool): string {
  const parts: string[] = [`Tool: ${tool.namespacedName}`, `Description: ${tool.tool.description ?? ""}`];

  const schema = tool.tool.inputSchema as { properties?: Record<string, { description?: string; type?: string }> } | undefined;

  if (schema?.properties) {
    const paramDescs: string[] = [];
    for (const [paramName, paramInfo] of Object.entries(schema.properties)) {
      const desc = paramInfo.description ?? "";
      const type = paramInfo.type ?? "";
      paramDescs.push(`${paramName} (${type}): ${desc}`);
    }
    if (paramDescs.length > 0) {
      parts.push(`Parameters: ${paramDescs.join(", ")}`);
    }
  }

  return parts.join("\n");
}
