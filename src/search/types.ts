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
 * Convert a snake_case identifier to space-separated words.
 * e.g. "todoist_task_update" → "todoist task update", "task_id" → "task id"
 */
function snakeToWords(s: string): string {
  return s.replace(/_/g, " ");
}

/**
 * Convert a tool definition into a text representation for embedding.
 *
 * Combines the tool name (as natural words), description, and parameter
 * names (as natural words).
 *
 * NOTE: Parameter *descriptions* are intentionally excluded. They are often
 * verbose and repetitive (e.g. "(optional)", "takes precedence over X"),
 * which dilutes the embedding and pushes the most relevant tools down in
 * the ranking. Empirically, a tool with 15 verbose parameter descriptions
 * (~200 words) ranks below a tool with 2 parameters (~40 words) even when
 * the former is the obvious match — the parameter noise drowns out the
 * signal from the tool name and description. Parameter *names* are kept
 * because they carry useful semantic signal (e.g. "task_id", "due_date")
 * without the dilution.
 */
export function toolToText(tool: IndexedTool): string {
  const parts: string[] = [`Tool: ${snakeToWords(tool.namespacedName)}`, `Description: ${tool.tool.description ?? ""}`];

  const schema = tool.tool.inputSchema as { properties?: Record<string, unknown> } | undefined;

  if (schema?.properties) {
    const paramNames = Object.keys(schema.properties).map(snakeToWords);
    if (paramNames.length > 0) {
      parts.push(`Parameters: ${paramNames.join(", ")}`);
    }
  }

  return parts.join("\n");
}
