/** MCP Nexus server — exposes browse-first tools for discovering and invoking upstream MCP tools */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, constants as ZLIB } from "node:zlib";
import { logger } from "./logger.js";
import { namespaceTool, parseNamespacedName } from "./namespace.js";
import type { IndexedTool, NexusConfig, NexusIndex } from "./types.js";

// Transport-specific callers
import { callTool as httpCallTool, fetchTools as httpFetchTools } from "./sources/http-source.js";
import { callTool as stdioCallTool, fetchTools as stdioFetchTools } from "./sources/stdio-source.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Supported MCP protocol versions (from @modelcontextprotocol/sdk)
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };
const SERVER_VERSION = pkg.version;

// ─── Tool Definitions ───────────────────────────────────────────────────────

const BROWSE_SERVICES_TOOL: Tool = {
  name: "browse_services",
  description:
    "List all available MCP services in the nexus. Returns an array of service objects, each with id, name, and description. Use this first to discover what services are available.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const BROWSE_TOOLS_TOOL: Tool = {
  name: "browse_tools",
  description:
    "List all tools provided by a specific service. Returns an array of namespaced tool names (e.g. 'todoist__get-task'). Pass the serviceId from browse_services.",
  inputSchema: {
    type: "object",
    properties: {
      serviceId: {
        type: "string",
        description: "The ID of the service to browse tools for (returned by browse_services)",
      },
    },
    required: ["serviceId"],
  },
};

const GET_SCHEMAS_TOOL: Tool = {
  name: "get_schemas",
  description:
    "Get the full input schemas for one or more tools. Accepts an array of namespaced tool names (e.g. ['todoist__get-task', 'outlook__search-emails']). Returns the complete inputSchema for each tool.",
  inputSchema: {
    type: "object",
    properties: {
      toolNames: {
        type: "array",
        items: { type: "string" },
        description: "Array of namespaced tool names to get schemas for",
      },
    },
    required: ["toolNames"],
  },
};

const CALL_TOOL_TOOL: Tool = {
  name: "call_tool",
  description:
    "Call a tool on an upstream MCP service. Pass the namespaced tool name (e.g. 'todoist__get-task') and its parameters. The response is passed through from the upstream service.",
  inputSchema: {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "The namespaced tool name to call (e.g. 'todoist__get-task')",
      },
      parameters: {
        type: "object",
        description: "The parameters to pass to the tool, matching its input schema",
      },
    },
    required: ["toolName"],
  },
};

const INDEX_TOOL: Tool = {
  name: "index",
  description:
    "Get a summary of the current nexus index — how many sources and tools are registered, and any sources with errors. Useful for monitoring and debugging.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ─── Nexus Tools (our 5 management tools) ─────────────────────────────

const NEXUS_TOOLS: Tool[] = [BROWSE_SERVICES_TOOL, BROWSE_TOOLS_TOOL, GET_SCHEMAS_TOOL, CALL_TOOL_TOOL, INDEX_TOOL];

/**
 * Cached preloaded tool schemas — resolved after indexing and appended to
 * tools/list responses so agents can call them without browsing.
 */
let preloadedToolSchemas: Tool[] = [];

/**
 * Resolve per-source preloaded tool names against the built index.
 * Names are non-prefixed (e.g. "get-task") and are resolved within each source.
 * Must be called after buildIndex() completes.
 */
export function resolvePreloadedTools(index: NexusIndex): void {
  const schemas: Tool[] = [];

  for (const [sourceId, state] of index.sources) {
    const names = state.config.preloadedTools;
    if (!names || names.length === 0) continue;

    for (const name of names) {
      const namespaced = namespaceTool(sourceId, name);
      const indexed = index.tools.get(namespaced);
      if (indexed) {
        // Surface the tool with its namespaced name (e.g. "todoist__get-task")
        // so the agent can call it directly via call_tool.
        schemas.push({ ...indexed.tool, name: namespaced });
      } else {
        logger.warn(`Preloaded tool "${name}" not found in source "${sourceId}"`);
      }
    }
  }

  preloadedToolSchemas = schemas;
  if (schemas.length > 0) {
    logger.info(`Preloaded ${schemas.length} tool(s) into tools/list`);
  }
}

// ─── Server Class ───────────────────────────────────────────────────────────

export class NexusServer {
  private httpServer: ReturnType<typeof createServer>;
  private index: NexusIndex;
  private config: NexusConfig;

  constructor(config: NexusConfig, index: NexusIndex) {
    this.config = config;
    this.index = index;
    this.httpServer = this.createHttpServer();
  }

  /** Re-fetch tools for a specific source and update the index */
  async refreshSource(sourceId: string): Promise<void> {
    const source = this.index.sources.get(sourceId);
    if (!source) return;

    logger.info(`Re-indexing source ${sourceId}...`);
    const fetcher = source.config.transport === "http" ? httpFetchTools : stdioFetchTools;
    const { tools, error } = await fetcher(source.config);

    if (error) {
      logger.warn(`Re-index of ${sourceId} failed: ${error}`);
      return;
    }

    // Remove old tools for this source
    for (const [name, indexed] of this.index.tools) {
      if (indexed.sourceId === sourceId) {
        this.index.tools.delete(name);
      }
    }

    // Repopulate with new tools
    source.tools = tools;
    const sourceTools: IndexedTool[] = [];
    for (const tool of tools) {
      const namespaced = namespaceTool(sourceId, tool.name);
      const indexed: IndexedTool = {
        sourceId,
        namespacedName: namespaced,
        tool,
      };
      this.index.tools.set(namespaced, indexed);
      sourceTools.push(indexed);
    }
    this.index.toolsBySource.set(sourceId, sourceTools);
    source.lastChecked = Date.now();
    source.lastError = error;
    logger.info(`Re-index of ${sourceId}: ${tools.length} tools`);
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      switch (name) {
        case "browse_services":
          return this.handleBrowseServices();
        case "browse_tools":
          return this.handleBrowseTools(args);
        case "get_schemas":
          return this.handleGetSchemas(args);
        case "call_tool":
          return this.handleCallTool(args);
        case "index":
          return this.handleIndex();
        default:
          // Preloaded tools (e.g. "ebay__ebay_get_orders") arrive here directly
          // since they're surfaced in tools/list. Route them through call_tool dispatch.
          return this.handleCallTool({ toolName: name, parameters: args });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Tool ${name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }

  // ─── browse_services ─────────────────────────────────────────────────────

  private handleBrowseServices() {
    const services = Array.from(this.index.sources.values()).map((state) => ({
      id: state.config.id,
      name: state.config.name,
      description: state.config.description,
      toolCount: state.tools.length,
      status: state.lastError ? "unavailable" : "ok",
      lastError: state.lastError ?? null,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(services),
        },
      ],
    };
  }

  // ─── browse_tools ────────────────────────────────────────────────────────

  private handleBrowseTools(args: Record<string, unknown>) {
    const serviceId = String(args["serviceId"] ?? "");
    if (!serviceId) {
      return {
        content: [{ type: "text", text: "Missing required parameter: serviceId" }],
        isError: true,
      };
    }

    const source = this.index.sources.get(serviceId);
    if (!source) {
      return {
        content: [
          {
            type: "text",
            text: `Service not found: ${serviceId}. Use browse_services to see available services.`,
          },
        ],
        isError: true,
      };
    }

    const sourceTools = this.index.toolsBySource.get(serviceId);
    const toolNames = sourceTools ? sourceTools.map((t) => t.namespacedName) : [];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ serviceId, tools: toolNames }),
        },
      ],
    };
  }

  // ─── get_schemas ─────────────────────────────────────────────────────────

  private handleGetSchemas(args: Record<string, unknown>) {
    const toolNames = args["toolNames"];
    if (!Array.isArray(toolNames) || toolNames.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Missing required parameter: toolNames (non-empty array of namespaced tool names)",
          },
        ],
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

    for (const raw of toolNames) {
      const name = String(raw);
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ schemas, missing: missing.length > 0 ? missing : undefined }),
        },
      ],
    };
  }

  // ─── call_tool ───────────────────────────────────────────────────────────

  private async handleCallTool(args: Record<string, unknown>) {
    const toolName = String(args["toolName"] ?? "");
    const parameters = (args["parameters"] ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return {
        content: [{ type: "text", text: "Missing required parameter: toolName" }],
        isError: true,
      };
    }

    const parsed = parseNamespacedName(toolName);
    if (!parsed) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid tool name format: ${toolName}. Expected format: <sourceId>__<toolName> (e.g. todoist__get-task)`,
          },
        ],
        isError: true,
      };
    }

    const source = this.index.sources.get(parsed.sourceId);
    if (!source) {
      return {
        content: [
          {
            type: "text",
            text: `Source not found: ${parsed.sourceId}. Has the nexus been indexed?`,
          },
        ],
        isError: true,
      };
    }

    // Check the tool exists in our index
    const indexed = this.index.tools.get(toolName);
    if (!indexed) {
      return {
        content: [
          {
            type: "text",
            text: `Tool '${toolName}' not found in nexus. Use browse_tools to see available tools for this service.`,
          },
        ],
        isError: true,
      };
    }

    // Route to the right transport
    const caller = source.config.transport === "http" ? httpCallTool : stdioCallTool;
    const result = await caller(source.config, parsed.toolName, parameters);

    if (result.error) {
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
            text: JSON.stringify({
              error: result.error,
              source: parsed.sourceId,
              tool: toolName,
              staleSchemaRefreshed: isStaleSchema,
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.content),
        },
      ],
    };
  }

  // ─── index (diagnostic) ──────────────────────────────────────────────────

  private handleIndex() {
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summary),
        },
      ],
    };
  }

  // ─── MCP JSON-RPC Handler ───────────────────────────────────────────────

  /**
   * Handles a single MCP JSON-RPC request and returns a JSON-RPC response,
   * or undefined for notifications (no response needed).
   */
  private async handleMcpRequest(msg: { method: string; id?: unknown; params?: unknown }): Promise<Record<string, unknown> | undefined> {
    const { method, id, params } = msg;

    switch (method) {
      case "initialize": {
        const p = (params ?? {}) as { protocolVersion?: string };
        const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
        // Negotiate: accept if supported, otherwise fall back to latest
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "mcp-nexus", version: SERVER_VERSION },
          },
        };
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        // No response needed for notifications
        return undefined;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: { tools: [...NEXUS_TOOLS, ...preloadedToolSchemas] },
        };

      case "tools/call": {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = p.name ?? "";
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        const result = await this.handleToolCall(name, args);
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: result.content,
            isError: result.isError,
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  // ─── JSON-RPC Error Helper ──────────────────────────────────────────────

  /** Send a JSON-RPC error response with proper envelope and protocol header. */
  private sendJsonRpcError(
    res: ServerResponse,
    statusCode: number,
    code: number,
    message: string,
    extraHeaders?: Record<string, string>,
  ): void {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
    const buf = Buffer.from(body, "utf-8");
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": buf.length,
      "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
      ...extraHeaders,
    });
    res.end(buf);
  }

  // ─── Response Compression ───────────────────────────────────────────────

  /** Compress and send a JSON body, respecting the client's Accept-Encoding. */
  private sendJsonResponse(
    req: IncomingMessage,
    res: ServerResponse,
    statusCode: number,
    body: Record<string, unknown> | Record<string, unknown>[],
  ): void {
    const raw = JSON.stringify(body);
    const accept = (req.headers["accept-encoding"] as string) ?? "";

    // Brotli is best, gzip is next best, otherwise plain text
    if (accept.includes("br") && raw.length > 256) {
      const compressed = brotliCompressSync(raw, {
        params: { [ZLIB.BROTLI_PARAM_QUALITY]: 4 },
      });
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Encoding": "br",
        "Content-Length": compressed.length,
        "mcp-protocol-version": "2025-11-05",
        Vary: "Accept-Encoding",
      });
      res.end(compressed);
    } else if (accept.includes("gzip") && raw.length > 256) {
      const compressed = gzipSync(raw, { level: 3 });
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": compressed.length,
        "mcp-protocol-version": "2025-11-05",
        Vary: "Accept-Encoding",
      });
      res.end(compressed);
    } else {
      const buf = Buffer.from(raw, "utf-8");
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": buf.length,
        "mcp-protocol-version": "2025-11-05",
        ...(accept.includes("br") || accept.includes("gzip") ? { Vary: "Accept-Encoding" } : {}),
      });
      res.end(buf);
    }
  }

  // ─── HTTP Server ─────────────────────────────────────────────────────────

  private createHttpServer() {
    return createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers — use reflective CORS when auth is enabled
      if (this.config.auth.enabled) {
        const origin = req.headers["origin"];
        const allowed = this.config.auth.allowedOrigins;
        // With an allowlist configured, only echo permitted origins; otherwise
        // fall back to reflecting the request origin (still scoped by bearer auth).
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

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health endpoint
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
        return;
      }

      // Auth check (unless disabled)
      if (this.config.auth.enabled) {
        const authHeader = req.headers["authorization"] ?? "";
        const expected = `Bearer ${this.config.auth.token}`;
        // Timing-safe comparison
        const aBuf = Buffer.from(authHeader);
        const bBuf = Buffer.from(expected);
        const match = aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
        if (!match) {
          this.sendJsonRpcError(res, 401, -32001, "Unauthorized");
          return;
        }
      }

      // GET requests — we don't support SSE streaming. Respond 405 so the client
      // knows immediately and doesn't waste time trying to parse non-SSE responses.
      if (req.method === "GET") {
        this.sendJsonRpcError(res, 405, -32003, "SSE streaming not supported — use POST for JSON-RPC", {
          Allow: "POST, OPTIONS, DELETE",
        });
        return;
      }

      // DELETE — terminate session (per MCP Streamable HTTP spec)
      if (req.method === "DELETE") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", result: {}, id: null }));
        return;
      }

      // Only POST for MCP
      if (req.method !== "POST") {
        this.sendJsonRpcError(res, 405, -32003, "Method not allowed", {
          Allow: "GET, POST, OPTIONS, DELETE",
        });
        return;
      }

      // ─── POST validation ───────────────────────────────────────────────────

      // Validate Content-Type
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("application/json")) {
        this.sendJsonRpcError(res, 400, -32600, "Invalid Content-Type — expected application/json");
        return;
      }

      // Validate Accept header (must accept JSON)
      const acceptHeader = req.headers["accept"] ?? "";
      if (!acceptHeader.includes("application/json") && !acceptHeader.includes("*/*") && acceptHeader.length > 0) {
        this.sendJsonRpcError(res, 400, -32600, "Invalid Accept header — expected application/json");
        return;
      }

      // Validate MCP protocol version
      const reqProtocolVersion = req.headers["mcp-protocol-version"] as string | undefined;
      if (reqProtocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(reqProtocolVersion)) {
        this.sendJsonRpcError(res, 400, -32600, `Unsupported mcp-protocol-version: ${reqProtocolVersion}`);
        return;
      }

      try {
        // Read body with size limit
        const buffers: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > MAX_BODY_BYTES) {
            this.sendJsonRpcError(res, 413, -32002, "Request body too large");
            return;
          }
          buffers.push(buf);
        }
        const body = Buffer.concat(buffers).toString("utf-8");
        if (!body) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
          return;
        }

        let rawMessage: unknown;
        try {
          rawMessage = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null }));
          return;
        }

        // Handle batch and single messages
        const messages = Array.isArray(rawMessage) ? rawMessage : [rawMessage];
        const responses: Record<string, unknown>[] = [];

        for (const msg of messages) {
          if (typeof msg !== "object" || msg === null || !("method" in msg)) {
            continue;
          }
          const typedMsg = msg as { method: string; id?: unknown; params?: unknown };
          const resp = await this.handleMcpRequest(typedMsg);
          if (resp !== undefined) {
            responses.push(resp);
          }
        }

        if (responses.length === 0) {
          // All were notifications — ACK with 202 and null body
          res.writeHead(202, {
            "Content-Type": "application/json",
            "Content-Length": 0,
            "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
          });
          res.end();
          return;
        }

        const responseBody = responses.length === 1 ? responses[0] : responses;
        this.sendJsonResponse(req, res, 200, responseBody);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`HTTP handler error: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
        }
      }
    });
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
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
    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info("HTTP server closed");
        resolve();
      });
    });
  }
}
