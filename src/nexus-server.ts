/** MCP Nexus server — exposes browse-first tools for discovering and invoking upstream MCP tools */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { updateSourceInIndex } from "./indexer.js";
import { logger } from "./logger.js";
import { namespaceTool, parseNamespacedName } from "./namespace.js";
import type { SearchEngine } from "./search/index.js";
import type { NexusConfig, NexusIndex, UpstreamCallResult } from "./types.js";

// Transport-specific callers
import { callTool as httpCallTool, fetchTools as httpFetchTools } from "./sources/http-source.js";
import { callTool as stdioCallTool, fetchTools as stdioFetchTools } from "./sources/stdio-source.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };
const SERVER_VERSION = pkg.version;

/**
 * Protocol version sent in the `mcp-protocol-version` response header.
 * The SDK validates the *request* header but does not set it on responses,
 * so we inject it via the response wrapper below.
 * Uses the SDK's own default negotiated version to stay in sync.
 */
const MCP_PROTOCOL_VERSION = DEFAULT_NEGOTIATED_PROTOCOL_VERSION;

/**
 * Sends a JSON-RPC error response with the mcp-protocol-version header.
 * Used for pre-transport errors (auth, body size, parse) that bypass the SDK.
 */
function sendJsonRpcError(res: ServerResponse, statusCode: number, code: number, message: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// ─── Protocol Version Response Header ──────────────────────────────────────
//
// The SDK transport validates the `mcp-protocol-version` *request* header but
// never sets it on *responses*. The spec requires it on all POST responses.
// The transport delegates to @hono/node-server, which calls
// `outgoing.writeHead(status, headerRecord)` as its primary response path
// (and `flushHeaders()` for unbuffered SSE streams). We monkey-patch just
// those two methods to inject the header, forwarding everything else.
//
// Note: A Proxy approach was tried first but caused requests to hang — the
// Proxy's `get` trap returns a new function each time `writeHead` is accessed,
// which breaks Hono's internal response flow. Direct monkey-patching works.

/**
 * Patches a ServerResponse so that every `writeHead` / `flushHeaders` call
 * includes the `mcp-protocol-version` response header.
 */
function withProtocolVersionHeader(res: ServerResponse): ServerResponse {
  const originalWriteHead = res.writeHead.bind(res);
  const originalFlushHeaders = res.flushHeaders.bind(res);

  res.writeHead = ((statusCode: number, ...rest: unknown[]): ServerResponse => {
    // writeHead overloads: (status) | (status, headers) | (status, message, headers)
    let headers: Record<string, string | string[]> | undefined;
    if (rest.length === 1 && typeof rest[0] === "object" && rest[0] !== null) {
      headers = { ...(rest[0] as Record<string, string | string[]>) };
    } else if (rest.length === 2 && typeof rest[1] === "object" && rest[1] !== null) {
      headers = { ...(rest[1] as Record<string, string | string[]>) };
    }
    if (headers) {
      headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
      return originalWriteHead(statusCode, headers);
    }
    // No headers arg — set via setHeader so writeHead picks it up
    if (!res.hasHeader("mcp-protocol-version")) {
      res.setHeader("mcp-protocol-version", MCP_PROTOCOL_VERSION);
    }
    return originalWriteHead(statusCode, ...(rest as []));
  }) as typeof res.writeHead;

  res.flushHeaders = (): void => {
    if (!res.hasHeader("mcp-protocol-version")) {
      res.setHeader("mcp-protocol-version", MCP_PROTOCOL_VERSION);
    }
    originalFlushHeaders();
  };

  return res;
}

// ─── Server Class ───────────────────────────────────────────────────────────

/** A connected client session: its own transport + McpServer instance */
interface ClientSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

export class NexusServer {
  private httpServer: ReturnType<typeof createServer>;
  private index: NexusIndex;
  private config: NexusConfig;
  private searchEngine: SearchEngine;
  /** Namespaced names of preloaded tools (populated by resolvePreloadedTools) */
  private preloadedToolNames: Set<string> = new Set();
  /** Per-source Promise chain locks for serializing index mutations (A2) */
  private sourceLocks = new Map<string, Promise<void>>();
  /**
   * Active client sessions, keyed by session ID.
   *
   * The SDK's StreamableHTTPServerTransport is single-session: once one client
   * calls `initialize`, the transport locks to that session and rejects all
   * other clients. To support multiple concurrent clients (e.g. VS Code +
   * another agent), we create a new transport + McpServer pair per session,
   * following the SDK's own `simpleStreamableHttp` example.
   */
  private sessions = new Map<string, ClientSession>();

  constructor(config: NexusConfig, index: NexusIndex, searchEngine: SearchEngine) {
    this.config = config;
    this.index = index;
    this.searchEngine = searchEngine;

    // Create the HTTP server with middleware (auth, CORS, health)
    this.httpServer = this.createHttpServer();
  }

  /** Register the 6 nexus management tools with the given SDK McpServer instance */
  private registerNexusTools(mcpServer: McpServer): void {
    // ─── browse_services ───────────────────────────────────────────────────
    mcpServer.registerTool(
      "browse_services",
      {
        description:
          "List all available MCP services in the nexus. Returns an array of service objects, each with id, name, and description. Use this first to discover what services are available.",
      },
      async () => {
        const services = Array.from(this.index.sources.values()).map((state) => ({
          id: state.config.id,
          name: state.config.name,
          description: state.config.description,
          toolCount: state.tools.length,
          status: state.lastError ? "unavailable" : "ok",
          lastError: state.lastError ?? null,
        }));
        return { content: [{ type: "text", text: JSON.stringify(services) }] };
      },
    );

    // ─── browse_tools ─────────────────────────────────────────────────────
    mcpServer.registerTool(
      "browse_tools",
      {
        description:
          "List all tools provided by a specific service. Returns an array of namespaced tool names (e.g. 'todoist__get-task'). Pass the serviceId from browse_services.",
        inputSchema: {
          serviceId: z.string().describe("The ID of the service to browse tools for (returned by browse_services)"),
        },
      },
      async ({ serviceId }) => {
        if (!serviceId) {
          return { content: [{ type: "text", text: "Missing required parameter: serviceId" }], isError: true };
        }

        const source = this.index.sources.get(serviceId);
        if (!source) {
          return {
            content: [{ type: "text", text: `Service not found: ${serviceId}. Use browse_services to see available services.` }],
            isError: true,
          };
        }

        const sourceTools = this.index.toolsBySource.get(serviceId);
        const toolNames = sourceTools ? sourceTools.map((t) => t.namespacedName) : [];

        return { content: [{ type: "text", text: JSON.stringify({ serviceId, tools: toolNames }) }] };
      },
    );

    // ─── search_tools ─────────────────────────────────────────────────────
    // Description is dynamic based on the active search strategy so the LLM
    // knows whether to use keyword-style queries (lexical) or natural-language
    // queries (semantic). The strategy is fixed at startup via config.
    const isSemantic = this.config.search.type === "semantic";
    const searchDescription = isSemantic
      ? "Search for tools across all services (or within a single service) by semantic similarity. Returns matching tool names and their service IDs, ranked by relevance. Use this to find the right tool without browsing every service. Use natural-language queries describing what you want to do (e.g. 'I want to send an email', 'find tools for managing my inbox')."
      : "Search for tools across all services (or within a single service) by keyword matching. Returns matching tool names and their service IDs, ranked by relevance. Use this to find the right tool without browsing every service. Use concise keywords that appear in tool names or descriptions (e.g. 'send email', 'ebay orders', 'create task').";
    const queryDescription = isSemantic
      ? "Search query — natural language description of what you want to do (e.g. 'I want to send an email', 'find tools for managing my inbox')"
      : "Search query — keywords that appear in tool names or descriptions (e.g. 'send email', 'ebay orders', 'create task')";

    mcpServer.registerTool(
      "search_tools",
      {
        description: searchDescription,
        inputSchema: {
          query: z.string().describe(queryDescription),
          serviceId: z.string().optional().describe("Optional: restrict search to a single service"),
        },
      },
      async ({ query, serviceId }) => {
        if (!query || !query.trim()) {
          return { content: [{ type: "text", text: "Missing required parameter: query" }], isError: true };
        }

        const result = await this.searchEngine.search(query, serviceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      },
    );

    // ─── get_schemas ───────────────────────────────────────────────────────
    mcpServer.registerTool(
      "get_schemas",
      {
        description:
          "Get the full input schemas for one or more tools. Accepts an array of namespaced tool names (e.g. ['todoist__get-task', 'outlook__search-emails']). Returns the complete inputSchema for each tool.",
        inputSchema: {
          toolNames: z.array(z.string()).describe("Array of namespaced tool names to get schemas for"),
        },
      },
      async ({ toolNames }) => {
        if (!Array.isArray(toolNames) || toolNames.length === 0) {
          return {
            content: [{ type: "text", text: "Missing required parameter: toolNames (non-empty array of namespaced tool names)" }],
            isError: true,
          };
        }

        const schemas: Array<{
          toolName: string;
          sourceId: string;
          description?: string;
          inputSchema: unknown;
        }> = [];
        const missing: string[] = [];

        for (const name of toolNames) {
          const indexed = this.index.tools.get(name);
          if (!indexed) {
            missing.push(name);
            continue;
          }
          schemas.push({
            toolName: name,
            sourceId: indexed.sourceId,
            description: indexed.tool.description,
            inputSchema: indexed.tool.inputSchema,
          });
        }

        return { content: [{ type: "text", text: JSON.stringify({ schemas, missing: missing.length > 0 ? missing : undefined }) }] };
      },
    );

    // ─── call_tool ─────────────────────────────────────────────────────────
    mcpServer.registerTool(
      "call_tool",
      {
        description:
          "Call a tool on an upstream MCP service. Pass the namespaced tool name (e.g. 'todoist__get-task') and its parameters. The response is passed through from the upstream service.",
        inputSchema: {
          toolName: z.string().describe("The namespaced tool name to call (e.g. 'todoist__get-task')"),
          parameters: z.record(z.unknown()).optional().describe("The parameters to pass to the tool, matching its input schema"),
        },
      },
      async ({ toolName, parameters = {} }) => this.executeCallTool(toolName, parameters),
    );

    // ─── index (diagnostic) ────────────────────────────────────────────────
    mcpServer.registerTool(
      "index",
      {
        description:
          "Get a summary of the current nexus index — how many sources and tools are registered, and any sources with errors. Useful for monitoring and debugging.",
      },
      async () => {
        const summary = {
          sources: Array.from(this.index.sources.values()).map((s) => ({
            id: s.config.id,
            name: s.config.name,
            transport: s.config.transport,
            toolCount: s.tools.length,
            available: !s.lastError,
            lastError: s.lastError ?? null,
            lastChecked: new Date(s.lastChecked).toISOString(),
          })),
          totalTools: this.index.tools.size,
          totalSources: this.index.sources.size,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      },
    );
  }

  /**
   * Override the SDK's tools/list handler to merge preloaded tools
   * (which carry their original JSON Schema from upstream) with the
   * SDK-registered nexus tools (which use Zod schemas).
   * Preloaded tools are registered with a passthrough Zod schema for
   * tools/call dispatch, but their real upstream JSON Schema is used
   * in the tools/list response.
   *
   * ⚠️ SDK COUPLING: This reaches into `mcpServer._registeredTools` (a private
   * SDK field) and replicates the SDK's own Zod→JSON Schema conversion logic.
   * This is unavoidable because `registerTool()` requires a Zod schema — it
   * throws if you pass a raw JSON Schema object. If the SDK ever adds native
   * raw-JSON-Schema support or changes `_registeredTools`, this method will
   * need updating. Pin the SDK version in package.json to avoid surprises.
   */
  private installToolsListHandler(mcpServer: McpServer): void {
    // Type for the SDK's internal registered tool structure
    type SdkRegisteredTool = {
      enabled: boolean;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
      execution?: unknown;
      _meta?: Record<string, unknown>;
    };
    type SdkRegisteredTools = Record<string, SdkRegisteredTool>;

    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Access the SDK's internal _registeredTools map
      const registered = (mcpServer as unknown as { _registeredTools: SdkRegisteredTools })._registeredTools;

      // Convert SDK-registered tools (Zod schemas → JSON Schema),
      // skipping preloaded tools which are added separately with their real schemas
      const sdkTools: McpTool[] = Object.entries(registered)
        .filter(([, tool]) => tool.enabled)
        .filter(([name]) => !this.preloadedToolNames.has(name))
        .map(([name, tool]): McpTool => {
          const toolDef: McpTool = {
            name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema
              ? (toJsonSchemaCompat(tool.inputSchema as Parameters<typeof toJsonSchemaCompat>[0], {
                  strictUnions: true,
                  pipeStrategy: "input",
                }) as McpTool["inputSchema"])
              : { type: "object" as const, properties: {} },
            annotations: tool.annotations as McpTool["annotations"],
            execution: tool.execution as McpTool["execution"],
            _meta: tool._meta,
          };

          if (tool.outputSchema) {
            toolDef.outputSchema = toJsonSchemaCompat(tool.outputSchema as Parameters<typeof toJsonSchemaCompat>[0], {
              strictUnions: true,
              pipeStrategy: "output",
            }) as McpTool["outputSchema"];
          }

          return toolDef;
        });

      // Append preloaded tools from the index (with their original upstream JSON Schema)
      const preloadedTools: McpTool[] = [];
      for (const name of this.preloadedToolNames) {
        const indexed = this.index.tools.get(name);
        if (indexed) {
          preloadedTools.push({
            name,
            description: indexed.tool.description,
            inputSchema: indexed.tool.inputSchema as McpTool["inputSchema"],
          });
        }
      }

      return { tools: [...sdkTools, ...preloadedTools] };
    });
  }

  /**
   * Resolve per-source preloaded tool names against the built index.
   * Registers them with all active McpServer sessions (using a passthrough Zod
   * schema so tools/call dispatch works) and stores their names for the custom
   * tools/list handler to merge with the correct upstream JSON Schema.
   * Must be called after buildIndex() completes.
   *
   * Note: New sessions created after this call will also get preloaded tools
   * registered during session creation (see createSession).
   */
  resolvePreloadedTools(): void {
    this.preloadedToolNames = new Set();
    const passthrough = z.object({}).passthrough();

    for (const [sourceId, state] of this.index.sources) {
      const names = state.config.preloadedTools;
      if (!names || names.length === 0) continue;

      for (const name of names) {
        const namespaced = namespaceTool(sourceId, name);
        const indexed = this.index.tools.get(namespaced);
        if (indexed) {
          this.preloadedToolNames.add(namespaced);
        } else {
          logger.warn(`Preloaded tool "${name}" not found in source "${sourceId}"`);
        }
      }
    }

    // Register preloaded tools on all active sessions
    for (const session of this.sessions.values()) {
      this.registerPreloadedToolsOnServer(session.mcpServer, passthrough);
    }

    if (this.preloadedToolNames.size > 0) {
      logger.info(`Preloaded ${this.preloadedToolNames.size} tool(s) into tools/list`);
      this.broadcastToolListChanged();
    }
  }

  /**
   * Generate embeddings for a recovered source's tools.
   * Called by the recovery poller after a source comes back online.
   */
  async generateEmbeddingsForSource(sourceId: string): Promise<void> {
    const embeddingIndex = this.searchEngine.getEmbeddingIndex();
    const provider = this.searchEngine.getEmbeddingProvider();
    if (!embeddingIndex || !provider) return; // lexical search — nothing to do

    const sourceTools = this.index.toolsBySource.get(sourceId) ?? [];

    // Remove old embeddings for this source (in case of re-recovery)
    embeddingIndex.removeSource(sourceId);

    // Generate new embeddings
    await embeddingIndex.generateEmbeddingsForSource(sourceTools, provider, this.config.search.semantic?.batchSize ?? 32);
  }

  /**
   * Register preloaded tools on a specific McpServer instance.
   * Called both during session creation and during resolvePreloadedTools.
   */
  private registerPreloadedToolsOnServer(mcpServer: McpServer, passthrough: z.ZodObject<{}, "passthrough">): void {
    for (const namespaced of this.preloadedToolNames) {
      const indexed = this.index.tools.get(namespaced);
      if (indexed) {
        mcpServer.registerTool(
          namespaced,
          {
            description: indexed.tool.description,
            inputSchema: passthrough,
          },
          async (args) => this.executeCallTool(namespaced, args as Record<string, unknown>),
        );
      }
    }
  }

  /** Send tool list changed notification to all active sessions */
  private broadcastToolListChanged(): void {
    for (const session of this.sessions.values()) {
      try {
        session.mcpServer.sendToolListChanged();
      } catch {
        // Session may have been closed concurrently — ignore
      }
    }
  }

  /** Shared call_tool implementation — also used for preloaded tool dispatch */
  private async executeCallTool(toolName: string, parameters: Record<string, unknown>): Promise<CallToolResult> {
    if (!toolName) {
      return { content: [{ type: "text", text: "Missing required parameter: toolName" }], isError: true };
    }

    const parsed = parseNamespacedName(toolName);
    if (!parsed) {
      return {
        content: [
          { type: "text", text: `Invalid tool name format: ${toolName}. Expected format: <sourceId>__<toolName> (e.g. todoist__get-task)` },
        ],
        isError: true,
      };
    }

    const source = this.index.sources.get(parsed.sourceId);
    if (!source) {
      return {
        content: [{ type: "text", text: `Source not found: ${parsed.sourceId}. Has the nexus been indexed?` }],
        isError: true,
      };
    }

    // Check the tool exists in our index
    const indexed = this.index.tools.get(toolName);
    if (!indexed) {
      return {
        content: [
          { type: "text", text: `Tool '${toolName}' not found in nexus. Use browse_tools to see available tools for this service.` },
        ],
        isError: true,
      };
    }

    // Route to the right transport
    const caller = source.config.transport === "http" ? httpCallTool : stdioCallTool;
    const result: UpstreamCallResult = await caller(source.config, parsed.toolName, parameters);

    if (result.error) {
      // A3: On transport error, update source status and add to failedSources
      source.lastError = result.error;
      this.index.failedSources.add(parsed.sourceId);

      // Check for stale-schema error — trigger re-index
      const isStaleSchema =
        result.error.includes("-32601") ||
        result.error.toLowerCase().includes("method not found") ||
        result.error.toLowerCase().includes("invalid params");

      if (isStaleSchema) {
        logger.info(`Stale schema detected for ${parsed.sourceId}, triggering re-index...`);
        await this.refreshSource(parsed.sourceId);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error, source: parsed.sourceId, tool: toolName, staleSchemaRefreshed: isStaleSchema }),
          },
        ],
        isError: true,
      };
    }

    // Clear error state on success (A3)
    if (source.lastError) {
      source.lastError = undefined;
      this.index.failedSources.delete(parsed.sourceId);
    }

    return { content: [{ type: "text", text: JSON.stringify(result.content) }] };
  }

  /** Re-fetch tools for a specific source and update the index (Q2 + A2) */
  async refreshSource(sourceId: string): Promise<void> {
    const source = this.index.sources.get(sourceId);
    if (!source) return;

    // A2: Serialize index mutations per source via a Promise chain lock
    const prev = this.sourceLocks.get(sourceId) ?? Promise.resolve();
    const next = prev.then(() => this.doRefreshSource(sourceId));
    this.sourceLocks.set(
      sourceId,
      next.catch(() => {}),
    ); // swallow to keep chain alive
    await next;
  }

  /** Internal: performs the actual re-index for a source (called under lock) */
  private async doRefreshSource(sourceId: string): Promise<void> {
    const source = this.index.sources.get(sourceId);
    if (!source) return;

    logger.info(`Re-indexing source ${sourceId}...`);
    const fetcher = source.config.transport === "http" ? httpFetchTools : stdioFetchTools;
    const { tools, error } = await fetcher(source.config);

    if (error) {
      logger.warn(`Re-index of ${sourceId} failed: ${error}`);
      source.lastError = error;
      this.index.failedSources.add(sourceId);
      return;
    }

    // Q2: Use shared updateSourceInIndex for O(source tools) deletion
    updateSourceInIndex(sourceId, tools, this.index);

    source.lastChecked = Date.now();
    source.lastError = undefined;
    this.index.failedSources.delete(sourceId);
    logger.info(`Re-index of ${sourceId}: ${tools.length} tools`);
  }

  // ─── HTTP Server (with middleware) ────────────────────────────────────────

  private createHttpServer() {
    return createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers — use reflective CORS when auth is enabled
      if (this.config.auth.enabled) {
        const origin = req.headers["origin"];
        const allowed = this.config.auth.allowedOrigins;
        if (origin && (!allowed || allowed.length === 0 || allowed.includes(origin))) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
      res.setHeader("Access-Control-Allow-Credentials", "true");

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health endpoint (non-MCP) — A5: enhanced with source availability
      if (req.method === "GET" && req.url === "/health") {
        const sources = Array.from(this.index.sources.values());
        const available = sources.filter((s) => !s.lastError).length;
        const failed = this.index.failedSources.size;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: failed === 0 ? "ok" : "degraded",
            uptime: process.uptime(),
            sources: { total: sources.length, available, failed },
            failedSourceIds: failed > 0 ? Array.from(this.index.failedSources) : undefined,
            totalTools: this.index.tools.size,
          }),
        );
        return;
      }

      // Auth check (unless disabled)
      if (this.config.auth.enabled) {
        const authHeader = req.headers["authorization"] ?? "";
        const expected = `Bearer ${this.config.auth.token}`;
        const aBuf = Buffer.from(authHeader);
        const bBuf = Buffer.from(expected);
        const match = aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
        if (!match) {
          sendJsonRpcError(res, 401, -32001, "Unauthorized");
          return;
        }
      }

      // Read and size-limit the request body for POST requests.
      // The SDK transport calls req.json() with no cap; by pre-reading with a
      // 1 MB limit and passing the parsed body as the 3rd arg, the SDK skips
      // its own req.json() call. GET/DELETE have no body.
      let parsedBody: unknown = undefined;
      if (req.method === "POST") {
        const MAX_BODY_BYTES = 1_048_576; // 1 MB — guards against memory exhaustion
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let bodyTooLarge = false;

        for await (const chunk of req) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            break;
          }
          chunks.push(chunk);
        }

        if (bodyTooLarge) {
          sendJsonRpcError(res, 413, -32000, "Request body too large (max 1 MB)");
          return;
        }

        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          sendJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
          return;
        }
      }

      // Delegate to the appropriate session transport.
      // The SDK's StreamableHTTPServerTransport is single-session, so we
      // maintain one transport + McpServer per client, keyed by mcp-session-id.
      // The SDK validates the mcp-protocol-version request header and handles
      // session lifecycle, method routing, Accept/Content-Type checks, and
      // JSON-RPC error envelopes natively. We only need to inject the
      // mcp-protocol-version *response* header via the wrapper.
      const wrapped = withProtocolVersionHeader(res);
      await this.handleMcpRequest(req, wrapped, parsedBody);
    });
  }

  /**
   * Route an MCP request to the correct session transport, or create a new
   * session for initialize requests.
   *
   * This follows the SDK's recommended multi-session pattern from
   * `simpleStreamableHttp.js`:
   * 1. If the request has a session ID and we have that session → reuse it
   * 2. If the request has no session ID and is an initialize request → create new session
   * 3. Otherwise → 400 error (no valid session)
   */
  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Case 1: Existing session — reuse its transport
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Case 2: New initialization request — create a new session
    if (!sessionId && parsedBody && isInitializeRequest(parsedBody)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          // Store the transport by session ID when the session is initialized.
          // This callback fires inside handleRequest, after the session ID has
          // been generated but before the response is sent — so we can safely
          // store the session for subsequent requests.
          this.sessions.set(sid, { transport, mcpServer });
          logger.debug(`Session initialized: ${sid} (active sessions: ${this.sessions.size})`);
        },
      });

      // Clean up when the session closes (client disconnect, DELETE, or error)
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && this.sessions.has(sid)) {
          this.sessions.delete(sid);
          logger.debug(`Session closed: ${sid} (active sessions: ${this.sessions.size})`);
        }
      };

      // Create a fresh McpServer for this session and register all tools
      const mcpServer = new McpServer({ name: "mcp-nexus", version: SERVER_VERSION }, { capabilities: { tools: { listChanged: true } } });
      this.registerNexusTools(mcpServer);
      this.installToolsListHandler(mcpServer);

      // Register any preloaded tools that were resolved before this session
      if (this.preloadedToolNames.size > 0) {
        this.registerPreloadedToolsOnServer(mcpServer, z.object({}).passthrough());
      }

      // Connect the transport to the McpServer BEFORE handling the request
      // so responses can flow back through the same transport
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Case 3: Invalid request — no session ID or not initialization
    sendJsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
  }

  // ─── Start / Shutdown ────────────────────────────────────────────────────

  async start(): Promise<void> {
    // No transport to connect at startup — sessions are created on demand
    // when clients send initialize requests.
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        logger.info(`mcp-nexus listening on port ${this.config.port}`);
        logger.info(`  MCP endpoint: POST http://0.0.0.0:${this.config.port}/`);
        logger.info(`  Health check: GET  http://0.0.0.0:${this.config.port}/health`);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down...");
    // Close all active sessions
    for (const [sid, session] of this.sessions) {
      try {
        await session.mcpServer.close();
      } catch {
        // Session may already be closed — ignore
      }
      this.sessions.delete(sid);
    }
    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info("HTTP server closed");
        resolve();
      });
    });
  }
}
