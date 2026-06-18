/** OpenAI-compatible embedding provider — calls /v1/embeddings endpoint */

import { logger } from "../../logger.js";
import type { EmbeddingProvider } from "../types.js";

/**
 * OpenAI-compatible embedding provider.
 *
 * Works with OpenAI, Azure OpenAI, LM Studio, or any service that implements
 * the /v1/embeddings API. Supports native batch input (array of texts in one call).
 *
 * Default model: text-embedding-3-small (1536 dimensions).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string, model = "text-embedding-3-small", dimensions = 1536) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.dimensions = dimensions;
  }

  async init(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("API key is required for openai-compatible provider");
    }

    logger.info(`Connecting to OpenAI-compatible API at ${this.baseUrl} (model: ${this.model})`);

    // Test connection by embedding a simple probe
    try {
      const probe = await this.embed("test");
      if (probe.length !== this.dimensions) {
        logger.info(`API model ${this.model} returns ${probe.length} dimensions (expected ${this.dimensions})`);
        (this as { dimensions: number }).dimensions = probe.length;
      }
      logger.info(`OpenAI-compatible embedding provider ready (${this.dimensions} dimensions)`);
    } catch (err) {
      throw new Error(`Failed to connect to embedding API at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!resp.ok) {
      throw new Error(`Embeddings API returned ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts: string[], batchSize: number): Promise<Float32Array[]> {
    const results: Float32Array[] = new Array(texts.length);
    const totalBatches = Math.ceil(texts.length / batchSize);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      logger.info(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);

      const resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!resp.ok) {
        throw new Error(`Embeddings API returned ${resp.status} on batch ${batchNum}: ${await resp.text()}`);
      }

      const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
      for (let j = 0; j < data.data.length; j++) {
        results[i + j] = new Float32Array(data.data[j].embedding);
      }
    }

    return results;
  }
}
