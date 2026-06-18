/**
 * Background recovery poller — periodically probes sources that failed at startup
 * and re-indexes them once they respond. Keeps the nexus live without restart.
 */

import { updateSourceInIndex } from "./indexer.js";
import { logger } from "./logger.js";
import type { NexusServer } from "./nexus-server.js";
import type { NexusIndex } from "./types.js";

// Transport-specific fetchers
import { fetchTools as httpFetch } from "./sources/http-source.js";
import { fetchTools as stdioFetch } from "./sources/stdio-source.js";

let pollTimer: ReturnType<typeof setInterval> | undefined;

export function startRecovery(index: NexusIndex, intervalMs: number, server: NexusServer): void {
  if (pollTimer) {
    logger.warn("Recovery poller already running, skipping");
    return;
  }

  logger.info(`Starting recovery poller every ${Math.round(intervalMs / 1000)}s`);

  pollTimer = setInterval(async () => {
    // P1: Use failedSources Set for O(1) lookup instead of iterating all sources
    if (index.failedSources.size === 0) return;

    // P1: Probe all failed sources concurrently with Promise.allSettled
    const probeResults = await Promise.allSettled(
      Array.from(index.failedSources).map(async (id) => {
        const state = index.sources.get(id);
        if (!state) return { id, recovered: false };

        logger.info(`Recovery probe: ${id}...`);
        const fetcher = state.config.transport === "http" ? httpFetch : stdioFetch;
        const { tools, error } = await fetcher(state.config);

        if (error) {
          logger.debug(`Recovery probe for ${id} still failing: ${error}`);
          return { id, recovered: false };
        }

        logger.info(`Recovery probe for ${id} succeeded — ${tools.length} tool(s) found, re-indexing`);

        // Q2: Use shared updateSourceInIndex for O(source tools) deletion
        updateSourceInIndex(id, tools, index);

        state.lastError = undefined;
        state.lastChecked = Date.now();
        index.failedSources.delete(id);

        // Generate embeddings for the recovered tools (no-op for lexical search)
        await server.generateEmbeddingsForSource(id);

        // Re-resolve preloaded tools so tools/list picks up any new schemas
        server.resolvePreloadedTools();

        logger.info(`Recovered source ${id}: ${tools.length} tools now available`);
        return { id, recovered: true };
      }),
    );

    // Log any unexpected rejections
    for (const result of probeResults) {
      if (result.status === "rejected") {
        logger.error(`Recovery probe error: ${result.reason}`);
      }
    }
  }, intervalMs);

  // Don't keep the process alive just for polling
  if (pollTimer && typeof pollTimer === "object" && "unref" in pollTimer) {
    pollTimer.unref();
  }
}

export function stopRecovery(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
    logger.info("Recovery poller stopped");
  }
}
