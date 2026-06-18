#!/usr/bin/env node

/**
 * mcp-nexus — browse-first MCP middleware
 *
 * Starts up, loads the YAML config, indexes all upstream MCP sources,
 * then exposes a Streamable HTTP MCP server with browse-first nexus tools.
 */

import { loadConfig } from "./config.js";
import { buildIndex } from "./indexer.js";
import { logger, setLogLevel } from "./logger.js";
import { NexusServer } from "./nexus-server.js";
import { startRecovery, stopRecovery } from "./recovery.js";
import { createEmbeddingProvider, generateToolEmbeddings, getEmbeddingIndex, SearchEngine } from "./search/index.js";
import { configureHttpConnector, shutdownHttp } from "./sources/http-source.js";
import { killAll } from "./sources/stdio-source.js";

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let configPath: string | undefined;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--config":
    case "-c":
      configPath = args[++i];
      break;
    case "--verbose":
    case "-v":
      verbose = true;
      break;
    case "--help":
    case "-h":
      console.log(`
mcp-nexus — browse-first MCP middleware

Usage:
  mcp-nexus [options]

Options:
  --config, -c <path>  Path to YAML config file (default: ./mcp-nexus.yaml)
  --verbose, -v        Enable debug logging
  --help, -h           Show this help
`);
      process.exit(0);
  }
}

if (verbose) {
  setLogLevel("debug");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("Starting mcp-nexus...");

  // 1. Load config
  const config = loadConfig(configPath);

  // Configure HTTP connection reuse + idle reaping
  configureHttpConnector(config.connectors.httpReuseIdleTimeoutSeconds);

  // 2. Index all sources
  logger.info("Indexing upstream MCP sources...");
  const index = await buildIndex(config.sources);

  // 2b. Initialize search engine (lexical or semantic)
  let searchEngine: SearchEngine;
  let embeddingProvider = undefined;
  if (config.search.type === "semantic" && config.search.semantic) {
    logger.info(`Initializing semantic search (provider: ${config.search.semantic.provider})...`);
    try {
      embeddingProvider = await createEmbeddingProvider(config.search);
      const embeddingIndex = getEmbeddingIndex(embeddingProvider!);
      if (embeddingIndex) {
        await generateToolEmbeddings(index, embeddingProvider!, embeddingIndex, config.search.semantic.batchSize);
      }
      searchEngine = new SearchEngine(config.search, index, embeddingProvider);
      searchEngine.setEmbeddingIndex(embeddingIndex!);
      logger.info("Semantic search initialized");
    } catch (err) {
      logger.error(`Failed to initialize semantic search: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn("Falling back to lexical search");
      searchEngine = new SearchEngine(config.search, index);
    }
  } else {
    searchEngine = new SearchEngine(config.search, index);
  }

  // 3. Start the nexus server
  const server = new NexusServer(config, index, searchEngine);

  // 3b. Resolve preloaded tools from the completed index
  server.resolvePreloadedTools();

  // 3c. Start background recovery polling for failed sources
  if (config.connectors.recoveryIntervalSeconds > 0) {
    startRecovery(index, config.connectors.recoveryIntervalSeconds * 1000, server);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutdown signal received");
    stopRecovery();
    await server.shutdown();
    shutdownHttp();
    killAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    // An uncaught exception leaves the process in an undefined state; log and
    // exit non-zero so the supervisor (Docker/systemd) restarts it cleanly.
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack ?? "");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
    process.exit(1);
  });

  await server.start();
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  logger.error(err.stack ?? "");
  process.exit(1);
});
