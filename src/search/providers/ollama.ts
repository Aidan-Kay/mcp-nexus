/** Ollama embedding provider — calls local Ollama /api/embeddings endpoint */

import { logger } from "../../logger.js";
import type { EmbeddingProvider } from "../types.js";

/**
 * Ollama embedding provider.
 *
 * Calls Ollama's /api/embeddings endpoint. Ollama doesn't support batch
 * input, so embedBatch sends concurrent requests (limited by batchSize as
 * concurrency).
 *
 * Default model: nomic-embed-text (768 dimensions).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model = "nomic-embed-text", dimensions = 768) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.dimensions = dimensions;
  }

  async init(): Promise<void> {
    logger.info(`Connecting to Ollama at ${this.baseUrl} (model: ${this.model})`);

    // Test connection by embedding a simple probe
    try {
      const probe = await this.embed("test");
      // Update dimensions based on actual response
      if (probe.length !== this.dimensions) {
        logger.info(`Ollama model ${this.model} returns ${probe.length} dimensions (expected ${this.dimensions})`);
        (this as { dimensions: number }).dimensions = probe.length;
      }
      logger.info(`Ollama embedding provider ready (${this.dimensions} dimensions)`);
    } catch (err) {
      throw new Error(`Failed to connect to Ollama at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embeddings API returned ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as { embedding: number[] };
    return new Float32Array(data.embedding);
  }

  async embedBatch(texts: string[], batchSize: number): Promise<Float32Array[]> {
    const results: Float32Array[] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / batchSize);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      logger.info(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);

      // Send concurrent requests within the batch
      const embeddings = await Promise.all(batch.map((text) => this.embed(text)));
      for (let j = 0; j < embeddings.length; j++) {
        results[i + j] = embeddings[j];
      }
    }

    return results;
  }
}
