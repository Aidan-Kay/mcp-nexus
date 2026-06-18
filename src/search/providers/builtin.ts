/** Built-in embedding provider using Transformers.js (Xenova/transformers) */

import { logger } from "../../logger.js";
import type { EmbeddingProvider } from "../types.js";

/**
 * Built-in embedding provider using @xenova/transformers.
 *
 * Downloads the model from HuggingFace Hub on first use and caches it
 * locally (in modelCachePath or the default Transformers.js cache dir).
 *
 * Uses all-MiniLM-L6-v2 by default: 384 dimensions, ~80MB, runs on CPU.
 */
export class BuiltinEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: any = null;
  private model: string;
  private cachePath?: string;

  constructor(model = "Xenova/all-MiniLM-L6-v2", cachePath?: string) {
    this.model = model;
    this.cachePath = cachePath;
  }

  async init(): Promise<void> {
    logger.info(`Loading embedding model: ${this.model}`);
    if (this.cachePath) {
      logger.info(`Model cache path: ${this.cachePath}`);
    }

    // Dynamic import — keeps @xenova/transformers out of the main bundle
    // and allows the server to start without it when using lexical search.
    const { pipeline, env } = await import("@xenova/transformers");

    // Transformers.js does NOT read TRANSFORMERS_CACHE env var — it defaults to
    // path.join(__dirname, '/.cache/') inside node_modules, which is read-only in
    // Docker. Must set env.cacheDir explicitly.
    if (this.cachePath) {
      env.cacheDir = this.cachePath;
    }

    this.pipeline = await pipeline("feature-extraction", this.model);
    logger.info(`Embedding model loaded (${this.dimensions} dimensions)`);
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) throw new Error("Provider not initialized");
    const output = await this.pipeline(text, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  async embedBatch(texts: string[], batchSize: number): Promise<Float32Array[]> {
    if (!this.pipeline) throw new Error("Provider not initialized");

    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);
      logger.info(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);

      // Process each text in the batch — Transformers.js pipeline handles
      // single texts as Float32Array and arrays as Float32Array[]
      for (const text of batch) {
        const output = await this.pipeline(text, { pooling: "mean", normalize: true });
        results.push(output.data as Float32Array);
      }
    }
    return results;
  }
}
