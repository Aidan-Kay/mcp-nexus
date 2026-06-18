/** Semantic search — stores tool embeddings and computes cosine similarity */

import { logger } from "../logger.js";
import type { IndexedTool } from "../types.js";
import type { EmbeddingProvider, ScoredResult } from "./types.js";
import { toolToText } from "./types.js";

/**
 * Stores tool embeddings and provides cosine similarity search.
 *
 * Embeddings are generated at index time (batched) and stored in memory.
 * At search time, only the query needs to be embedded — similarity is
 * computed via dot product (vectors are normalized).
 */
export class EmbeddingIndex {
  /** toolName → embedding vector */
  private embeddings = new Map<string, Float32Array>();
  /** toolName → sourceId (for serviceId filtering) */
  private toolSources = new Map<string, string>();
  private dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  /** Generate and store embeddings for all tools, batched */
  async generateEmbeddings(tools: Map<string, IndexedTool>, provider: EmbeddingProvider, batchSize: number): Promise<void> {
    const toolList = Array.from(tools.values());
    logger.info(`Generating embeddings for ${toolList.length} tools (batch size: ${batchSize})...`);

    // Convert all tools to text representations
    const texts = toolList.map((t) => toolToText(t));

    // Generate embeddings in batches
    const vectors = await provider.embedBatch(texts, batchSize);

    // Store
    for (let i = 0; i < toolList.length; i++) {
      const tool = toolList[i];
      const vec = vectors[i];
      this.embeddings.set(tool.namespacedName, vec);
      this.toolSources.set(tool.namespacedName, tool.sourceId);
    }

    logger.info(`Embeddings generated: ${this.embeddings.size} tools, ${this.dimensions} dimensions each`);
  }

  /** Search for tools by cosine similarity to the query embedding */
  search(queryEmbedding: Float32Array, serviceId?: string): ScoredResult[] {
    const scored: ScoredResult[] = [];

    for (const [name, vec] of this.embeddings) {
      if (serviceId && this.toolSources.get(name) !== serviceId) continue;

      // Cosine similarity = dot product (vectors are normalized)
      let dot = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * queryEmbedding[i];
      }

      // Only include positive similarities
      if (dot > 0) {
        scored.push({ name, serviceId: this.toolSources.get(name)!, score: dot });
      }
    }

    // Sort by score descending, then alphabetically for stable ordering
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return scored;
  }

  /** Remove embeddings for a source (used when re-indexing a recovered source) */
  removeSource(sourceId: string): void {
    for (const [name, src] of this.toolSources) {
      if (src === sourceId) {
        this.embeddings.delete(name);
        this.toolSources.delete(name);
      }
    }
  }

  /** Generate embeddings for a single source's tools (used during recovery) */
  async generateEmbeddingsForSource(
    tools: import("../types.js").IndexedTool[],
    provider: EmbeddingProvider,
    batchSize: number,
  ): Promise<void> {
    if (tools.length === 0) return;

    logger.info(`Generating embeddings for ${tools.length} recovered tool(s)...`);
    const texts = tools.map((t) => toolToText(t));
    const vectors = await provider.embedBatch(texts, batchSize);

    for (let i = 0; i < tools.length; i++) {
      this.embeddings.set(tools[i].namespacedName, vectors[i]);
      this.toolSources.set(tools[i].namespacedName, tools[i].sourceId);
    }

    logger.info(`Embeddings generated: ${tools.length} tool(s) added (${this.embeddings.size} total)`);
  }

  get size(): number {
    return this.embeddings.size;
  }
}
