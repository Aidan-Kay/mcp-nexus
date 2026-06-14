/** MCP Nexus server — exposes browse-first tools for discovering and invoking upstream MCP tools */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "./logger.js";
import { namespaceTool, parseNamespacedName } from "./namespace.js";
import type { IndexedTool, NexusConfig, NexusIndex } from "./types.js";

// Transport-specific callers
import { callTool as httpCallTool, fetchTools as httpFetchTools } from "./sources/http-source.js";
import { callTool as stdioCallTool, fetchTools as stdioFetchTools } from "./sources/stdio-source.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };
const SERVER_VERSION = pkg.version;

// ─── Server Class ───────────────────────────────────────────────────────────

export class NexusServer {
  private httpServer: ReturnType<typeof createServer>;
  /** The SDK McpServer instance — exposed for notifications */
  readonly mcpServer: McpServer;
  private transport: StreamableHTTPServerTransport;
  private index: NexusIndex;
  private config: NexusConfig;
  /** Namespaced names of preloaded tools (populated by resolvePreloadedTools) */
  private preloadedToolNames: Set<string> = new Set();

  constructor(config: NexusConfig, index: NexusIndex) {
    this.config = config;
    this.index = index;

    // Create the MCP server using the SDK's high-level API
    this.mcpServer = new McpServer({ name: "mcp-nexus", version: SERVER_VERSION }, { capabilities: { tools: { listChanged: true } } });

    // Register the 5 nexus management tools
    this.registerNexusTools();

    // Override the SDK's tools/list handler to merge preloaded tools
    // (which carry their original JSON Schema from upstream) with the
    // SDK-registered nexus tools (which use Zod schemas).
    this.installToolsListHandler();

    // Create the Streamable HTTP transport (stateful mode)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Create the HTTP server with middleware (auth, CORS, health)
    this.httpServer = this.createHttpServer();
  }

  /** Register the 5 nexus management tools with the SDK's McpServer */
  private registerNexusTools(): void {
    // ─── browse_services ───────────────────────────────────────────────────
    this.mcpServer.registerTool(
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
    this.mcpServer.registerTool(
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

    // ─── get_schemas ───────────────────────────────────────────────────────
    this.mcpServer.registerTool(
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
    this.mcpServer.registerTool(
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
    this.mcpServer.registerTool(
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
   */
  private installToolsListHandler(): void {
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

    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Access the SDK's internal _registeredTools map
      const registered = (this.mcpServer as unknown as { _registeredTools: SdkRegisteredTools })._registeredTools;

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
   * Registers them with the SDK's McpServer (using a passthrough Zod schema
   * so tools/call dispatch works) and stores their names for the custom
   * tools/list handler to merge with the correct upstream JSON Schema.
   * Must be called after buildIndex() completes.
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
          // Register with SDK using passthrough schema so tools/call dispatch works.
          // The custom tools/list handler replaces the schema with the upstream JSON Schema.
          this.mcpServer.registerTool(
            namespaced,
            {
              description: indexed.tool.description,
              inputSchema: passthrough,
            },
            async (args) => this.executeCallTool(namespaced, args as Record<string, unknown>),
          );
          this.preloadedToolNames.add(namespaced);
        } else {
          logger.warn(`Preloaded tool "${name}" not found in source "${sourceId}"`);
        }
      }
    }

    if (this.preloadedToolNames.size > 0) {
      logger.info(`Preloaded ${this.preloadedToolNames.size} tool(s) into tools/list`);
      this.mcpServer.sendToolListChanged();
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
            text: JSON.stringify({ error: result.error, source: parsed.sourceId, tool: toolName, staleSchemaRefreshed: isStaleSchema }),
          },
        ],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: JSON.stringify(result.content) }] };
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

      // Health endpoint (non-MCP)
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
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
          res.writeHead(401, {
            "Content-Type": "application/json",
            "mcp-protocol-version": "2025-03-26",
          });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
          return;
        }
      }

      // Delegate all MCP requests to the SDK transport
      await this.transport.handleRequest(req, res);
    });
  }

  // ─── Start / Shutdown ────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Connect the MCP server to the transport
    await this.mcpServer.connect(this.transport);

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
    await this.mcpServer.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info("HTTP server closed");
        resolve();
      });
    });
  }
}
