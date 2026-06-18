/** Startup indexer — contacts all sources, fetches tool lists, builds the in-memory nexus */

import { logger } from "./logger.js";
import { namespaceTool } from "./namespace.js";
import type { IndexedTool, NexusIndex, SourceConfig, SourceState } from "./types.js";

// Transport-specific fetchers
import { fetchTools as httpFetch } from "./sources/http-source.js";
import { fetchTools as stdioFetch } from "./sources/stdio-source.js";

/** Default request timeout for upstream calls (ms) */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Update the index for a single source: remove old tools, repopulate with new ones.
 * Shared by indexer, refreshSource, and recovery — avoids O(total tools) scan
 * by using toolsBySource to find the exact keys to delete.
 */
export function updateSourceInIndex(sourceId: string, tools: import("@modelcontextprotocol/sdk/types.js").Tool[], index: NexusIndex): void {
  // Remove old tools for this source — O(tools in source) via toolsBySource
  const oldTools = index.toolsBySource.get(sourceId) ?? [];
  for (const t of oldTools) {
    index.tools.delete(t.namespacedName);
  }

  // Repopulate with new tools
  const source = index.sources.get(sourceId);
  if (source) source.tools = tools;

  const sourceTools: IndexedTool[] = [];
  for (const tool of tools) {
    const namespaced = namespaceTool(sourceId, tool.name);
    const indexed: IndexedTool = {
      sourceId,
      namespacedName: namespaced,
      tool,
    };
    index.tools.set(namespaced, indexed);
    sourceTools.push(indexed);
  }
  index.toolsBySource.set(sourceId, sourceTools);
}

/** Build the initial index by fetching tools from every configured source */
export async function buildIndex(sources: SourceConfig[]): Promise<NexusIndex> {
  const sourceMap = new Map<string, SourceState>();
  const toolMap = new Map<string, IndexedTool>();
  const toolsBySource = new Map<string, IndexedTool[]>();
  const failedSources = new Set<string>();

  logger.info(`Building index: ${sources.length} source(s)`);

  const results = await Promise.allSettled(
    sources.map(async (config) => {
      const fetcher = config.transport === "http" ? httpFetch : stdioFetch;
      const { tools, error } = await fetcher(config);

      const state: SourceState = {
        config,
        tools,
        lastError: error,
        lastChecked: Date.now(),
      };
      return { config, state, tools, error };
    }),
  );

  results.forEach((result, idx) => {
    const config = sources[idx];

    if (result.status === "rejected") {
      // Fetchers normally catch their own errors; this is a defensive fallback.
      logger.error(`Indexer: source ${config.id} rejected — ${result.reason}`);
      const state: SourceState = {
        config,
        tools: [],
        lastError: String(result.reason),
        lastChecked: Date.now(),
      };
      sourceMap.set(config.id, state);
      toolsBySource.set(config.id, []);
      failedSources.add(config.id);
      return;
    }

    const { state, tools, error } = result.value;

    if (error) {
      logger.warn(`Indexer: source ${config.id} returned error — ${error}`);
      failedSources.add(config.id);
    }

    sourceMap.set(config.id, state);

    const sourceTools: IndexedTool[] = [];
    for (const tool of tools) {
      const namespaced = namespaceTool(config.id, tool.name);
      const indexed: IndexedTool = {
        sourceId: config.id,
        namespacedName: namespaced,
        tool,
      };
      toolMap.set(namespaced, indexed);
      sourceTools.push(indexed);
    }
    toolsBySource.set(config.id, sourceTools);

    logger.info(`Indexer: ${config.id} → ${tools.length} tool(s)${error ? ` (with error: ${error})` : ""}`);
  });

  logger.info(`Index built: ${sourceMap.size} sources, ${toolMap.size} tools total`);

  return { sources: sourceMap, tools: toolMap, toolsBySource, failedSources };
}
