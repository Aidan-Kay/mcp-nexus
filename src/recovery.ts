/**
 * Background recovery poller — periodically probes sources that failed at startup
 * and re-indexes them once they respond. Keeps the nexus live without restart.
 */

import { logger } from "./logger.js";
import { namespaceTool } from "./namespace.js";
import type { NexusServer } from "./nexus-server.js";
import type { IndexedTool, NexusIndex, SourceState } from "./types.js";

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
    const failed: Array<{ id: string; state: SourceState }> = [];

    for (const [id, state] of index.sources) {
      if (state.lastError) {
        failed.push({ id, state });
      }
    }

    if (failed.length === 0) return;

    for (const { id, state } of failed) {
      logger.info(`Recovery probe: ${id}...`);
      const fetcher = state.config.transport === "http" ? httpFetch : stdioFetch;
      const { tools, error } = await fetcher(state.config);

      if (error) {
        logger.debug(`Recovery probe for ${id} still failing: ${error}`);
        continue;
      }

      logger.info(`Recovery probe for ${id} succeeded — ${tools.length} tool(s) found, re-indexing`);

      // Remove old tools for this source
      for (const [name, indexed] of index.tools) {
        if (indexed.sourceId === id) {
          index.tools.delete(name);
        }
      }

      // Repopulate
      state.tools = tools;
      state.lastError = undefined;
      state.lastChecked = Date.now();

      const sourceTools: IndexedTool[] = [];
      for (const tool of tools) {
        const namespaced = namespaceTool(id, tool.name);
        const indexed: IndexedTool = {
          sourceId: id,
          namespacedName: namespaced,
          tool,
        };
        index.tools.set(namespaced, indexed);
        sourceTools.push(indexed);
      }
      index.toolsBySource.set(id, sourceTools);

      // Re-resolve preloaded tools so tools/list picks up any new schemas
      server.resolvePreloadedTools();

      logger.info(`Recovered source ${id}: ${tools.length} tools now available`);
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
