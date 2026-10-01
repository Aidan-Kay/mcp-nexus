/** MCP Nexus server — exposes browse-first tools for discovering and invoking upstream MCP tools */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveRun, writeArtefact, type ArtefactResult } from "./artefacts.js";
import { authenticate, ClientAccess, ConfirmationStore, logCall, type CallOutcome, type CallRecord } from "./gateway.js";
import { updateSourceInIndex } from "./indexer.js";
import { logger } from "./logger.js";
import { namespaceTool, parseNamespacedName } from "./namespace.js";
import { inferShape, minifyContent, relevantShape, replaceJsonBlock, resolveJsonBlock, selectPaths, textOf, type ContentBlock } from "./response.js";
import type { SearchEngine } from "./search/index.js";
import type { IndexedTool, NexusConfig, NexusIndex, UpstreamCallResult } from "./types.js";
import { validateArguments } from "./validation.js";
import { compactSchema } from "./compact-schema.js";

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
 * call_tool's own arguments. `parameters` is an open record, so nesting one of
 * these inside it validates cleanly and is then forwarded upstream as if it were
 * a tool argument — see checkMisplacedArguments.
 */
const NEXUS_CALL_ARGS = ["select", "artefacts", "confirm", "toolName"] as const;

/**
 * How long shutdown waits for in-flight calls before closing sessions and letting the
 * caller kill stdio children. Under Docker's default ten-second stop grace, so the
 * drain finishes before SIGKILL rather than being cut off by it.
 */
const SHUTDOWN_DRAIN_MS = 8_000;

/** call_tool's own options, as distinct from the upstream tool's parameters. */
interface CallOptions {
  select?: string[];
  artefacts?: string;
  confirm?: string;
  /** Dispatched as a preloaded tool, which has no `confirm` argument to pass. */
  preloaded?: boolean;
}

/** A call_tool result plus what the call log records about it. */
interface CallOutcomeResult {
  result: CallToolResult;
  outcome: CallOutcome;
  confirmed?: true;
}

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
  /** The client that initialized the session; every later request must authenticate as it. */
  access: ClientAccess;
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
   * Inferred response shapes, keyed by namespaced tool name, learned from calls
   * as they pass through. Most upstream services declare no outputSchema, so this
   * is the only way a caller can discover what a tool returns without reading a
   * whole response — which is precisely what `select` exists to avoid.
   */
  private responseShapes = new Map<string, string[]>();
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
  private confirmations = new ConfirmationStore();
  /** POST requests whose response has not finished, so shutdown can let them complete. */
  private inFlight = new Set<Promise<void>>();
  private closing = false;

  constructor(config: NexusConfig, index: NexusIndex, searchEngine: SearchEngine) {
    this.config = config;
    this.index = index;
    this.searchEngine = searchEngine;

    // Create the HTTP server with middleware (auth, CORS, health)
    this.httpServer = this.createHttpServer();
  }

  /**
   * Render the `instructions` string returned in the initialize result.
   *
   * Clients inject this into the model's system prompt, so the service roster is
   * known before the first tool call — `browse_services` becomes a fallback for
   * clients that ignore instructions rather than a mandatory opening move.
   *
   * ⚠️ Instructions are sent once, in the initialize response, and no
   * notification exists to revise them. Anything volatile written here stays
   * wrong for the rest of the session: the recovery poller flips availability
   * every `recoveryIntervalSeconds`, so live status belongs in `browse_services`
   * and `index`, which are called at the moment the answer matters. Only what
   * outlives a session goes here — which services exist and what each covers —
   * and a source that was down at index time is named as such rather than
   * quietly reported as having no tools.
   */
  private renderInstructions(access: ClientAccess): string {
    // A service whose every tool this client is denied is left out altogether, rather
    // than listed with nothing in it.
    const roster = Array.from(this.index.sources.values()).flatMap((state) => {
      const { id, name, description } = state.config;
      if (state.tools.length === 0) return [`- ${id} (${name}) — ${description} [unavailable at session start]`];
      const visible = this.visibleTools(id, access).length;
      return visible > 0 ? [`- ${id} (${name}) — ${description} [${visible} tools]`] : [];
    });

    return [
      "mcp-nexus fronts several upstream MCP services behind one set of tools. Configured services:",
      "",
      roster.length > 0 ? roster.join("\n") : "- (none indexed)",
      "",
      "That roster is a snapshot taken when this session opened — call `index` for current availability. " +
        "Use `search_tools` to find a tool by what you want to do — each hit carries its schema, so you can " +
        "`call_tool` straight from the results unless the hit lists `inputSchemaTrimmed`. Call `get_schemas` for " +
        "those, and for any tool you pick from `browse_tools`, which lists names only.",
    ].join("\n");
  }

  /** The tools of one source that a client may see. */
  private visibleTools(sourceId: string, access: ClientAccess): IndexedTool[] {
    return (this.index.toolsBySource.get(sourceId) ?? []).filter((t) => access.permits(t.namespacedName));
  }

  /** Everything get_schemas knows about a tool — search_tools returns a compact subset. */
  private describeTool(name: string, indexed: IndexedTool) {
    return {
      description: indexed.tool.description,
      inputSchema: indexed.tool.inputSchema,
      // Declared by the upstream service — absent on most, hence responseShape below
      outputSchema: indexed.tool.outputSchema,
      responseShape: this.responseShapes.get(name),
    };
  }

  /**
   * Register the 6 nexus management tools with the given SDK McpServer instance.
   * Each session has its own server, so every handler here is bound to one client.
   */
  private registerNexusTools(mcpServer: McpServer, access: ClientAccess): void {
    // ─── browse_services ───────────────────────────────────────────────────
    mcpServer.registerTool(
      "browse_services",
      {
        description:
          "List all available MCP services in the nexus. Returns an array of service objects, each with id, name, and description. Use this first to discover what services are available.",
      },
      async () => {
        const services = Array.from(this.index.sources.values()).flatMap((state) => {
          const toolCount = this.visibleTools(state.config.id, access).length;
          if (state.tools.length > 0 && toolCount === 0) return [];
          return [
            {
              id: state.config.id,
              name: state.config.name,
              description: state.config.description,
              toolCount,
              status: state.lastError ? "unavailable" : "ok",
              lastError: state.lastError ?? null,
            },
          ];
        });
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

        const toolNames = this.visibleTools(serviceId, access).map((t) => t.namespacedName);

        return { content: [{ type: "text", text: JSON.stringify({ serviceId, tools: toolNames }) }] };
      },
    );

    // ─── search_tools ─────────────────────────────────────────────────────
    // Description is dynamic based on the active search strategy so the LLM
    // knows whether to use keyword-style queries (lexical), natural-language
    // queries (semantic), or either (hybrid). The strategy is fixed at startup
    // via config.
    const isSemantic = this.config.search.type === "semantic";
    const isHybrid = this.config.search.type === "hybrid";
    // The opening sentence is the strategy's own; the rest is shared. The shared part
    // used to open with a generic version of the same sentence, so every description
    // said "Search for tools across all services" twice.
    const commonDescription =
      "Returns matching tools ranked by relevance, each with its description, inputSchema and — once the tool has been called — its responseShape. Structured arguments (nested objects, arrays of objects) are cut to their type and named in inputSchemaTrimmed: call get_schemas for those tools; any other hit can go straight to call_tool.";
    const similarityNote =
      " Each hit's 'similarity' (0-1) is how close it is to the query in meaning; compare it with 'minSimilarity' in the response to tell a close match from the best of a poor set.";
    const searchDescription = isHybrid
      ? "Search for tools across all services (or within a single service) by meaning and by name. " +
        commonDescription +
        " Each hit carries 'matched', saying whether it matched by meaning, by name, or both, and an exact tool name is pinned first." +
        similarityNote +
        " Only tools that match closely enough are returned, so an empty result means nothing matched: rephrase the query rather than assume the tool does not exist. Accepts both natural-language queries describing what you want to do (e.g. 'I want to send an email') and exact tool or parameter names (e.g. 'todoist_task_update', 'bidPercentage')."
      : isSemantic
        ? "Search for tools across all services (or within a single service) by semantic similarity. " +
          commonDescription +
          similarityNote +
          " Only tools similar enough to count as a match are returned, so an empty result means nothing matched: rephrase the query rather than assume the tool does not exist. Use natural-language queries describing what you want to do (e.g. 'I want to send an email', 'find tools for managing my inbox')."
        : "Search for tools across all services (or within a single service) by keyword matching. " +
          commonDescription +
          " Use concise keywords that appear in tool names or descriptions (e.g. 'send email', 'ebay orders', 'create task').";
    const queryDescription = isHybrid
      ? "Search query — natural language describing what you want to do, or an exact tool or parameter name (e.g. 'send an email', 'todoist_task_update', 'bidPercentage')"
      : isSemantic
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

        const { results, ...rest } = await this.searchEngine.search(query, serviceId, (name) => access.permits(name));
        // Every hit carries enough to call it: the round trip between finding a tool and
        // calling it was the common case, not the exception. The schema is compacted so
        // a few Graph-sized entities cannot swamp a search; outputSchema is left to
        // get_schemas for the same reason. A hit whose tool left the index mid-search
        // (a re-index) is dropped rather than returned without the schema it promises.
        const hits = results.flatMap(({ name, serviceId, matched, pinned, similarity }) => {
          const indexed = this.index.tools.get(name);
          if (!indexed) return [];
          const { schema, trimmed } = compactSchema(indexed.tool.inputSchema);
          return [
            {
              name,
              serviceId,
              matched,
              pinned,
              similarity,
              description: indexed.tool.description,
              inputSchema: schema,
              inputSchemaTrimmed: trimmed,
              responseShape: this.responseShapes.get(name),
            },
          ];
        });

        return { content: [{ type: "text", text: JSON.stringify({ ...rest, results: hits }) }] };
      },
    );

    // ─── get_schemas ───────────────────────────────────────────────────────
    mcpServer.registerTool(
      "get_schemas",
      {
        description:
          "Get the full input schemas for one or more tools. Accepts an array of namespaced tool names (e.g. ['todoist__get-task', 'outlook__search-emails']). Returns the complete inputSchema for each tool, plus 'responseShape' — the leaf paths and types of what the tool last returned — when this tool has been called before. Use responseShape to write the 'select' argument of call_tool. If it is absent, make one small call first (many tools take a limit/pageSize argument) and the shape will be recorded.",
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
          outputSchema?: unknown;
          responseShape?: string[];
        }> = [];
        const missing: string[] = [];

        for (const name of toolNames) {
          const indexed = this.index.tools.get(name);
          if (!indexed || !access.permits(name)) {
            missing.push(name);
            continue;
          }
          schemas.push({ toolName: name, sourceId: indexed.sourceId, ...this.describeTool(name, indexed) });
        }

        return { content: [{ type: "text", text: JSON.stringify({ schemas, missing: missing.length > 0 ? missing : undefined }) }] };
      },
    );

    // ─── call_tool ─────────────────────────────────────────────────────────
    //
    // The `artefacts` argument only exists when a root is configured. A nexus with
    // nowhere to write must not advertise the option — the schema is read by every
    // agent on every session, so an unusable argument is a permanent context cost
    // and an invitation to call something that can only fail.
    const artefactsEnabled = Boolean(this.config.artefacts);
    // `confirm` is advertised on the same principle, per client: only one whose policy
    // can ask for a confirmation is shown the argument that answers it.
    const confirmEnabled = access.confirms;
    const ownArguments = ["'select'", ...(artefactsEnabled ? ["'artefacts'"] : []), ...(confirmEnabled ? ["'confirm'"] : [])];
    const ownArgumentsText =
      ownArguments.length === 1 ? `${ownArguments[0]} is` : `${ownArguments.slice(0, -1).join(", ")} and ${ownArguments.at(-1)} are`;

    mcpServer.registerTool(
      "call_tool",
      {
        description:
          "Call a tool on an upstream MCP service. Pass the namespaced tool name (e.g. 'todoist__get-task') and its parameters. The response is passed through from the upstream service. Use 'select' to trim wide responses down to the fields you need — get_schemas reports a 'responseShape' you can write those paths from." +
          (artefactsEnabled
            ? " For results too large to be worth reading — a full orders feed, a whole catalogue — pass 'artefacts' instead: the response is written to a file and you get back its path, size and record count rather than the data."
            : "") +
          (confirmEnabled
            ? " Some tools need confirming: the first call is refused with a 'confirm' token. Tell the user what the call will do, and only once they agree repeat the identical call with that token as 'confirm'."
            : ""),
        inputSchema: {
          toolName: z.string().describe("The namespaced tool name to call (e.g. 'todoist__get-task')"),
          // ⚠️ Value type is spelled out explicitly rather than using z.unknown().
          // z.record(z.unknown()) serialises to `additionalProperties: {}` — an empty
          // schema meaning "any value" — which some MCP clients (Open WebUI's
          // pydantic model builder, grammar-constrained decoders) misread as
          // "object with no properties", silently replacing every scalar argument
          // with {}. Enumerating the permitted JSON types removes the ambiguity.
          // The element type is z.unknown(), not z.any(): z.any() emits a bare
          // `{ type: "array" }` with no `items`, which VS Code rejects outright
          // ("array type must have items"). z.unknown() emits `items: {}` and
          // stays permissive, so nested arrays still pass through.
          parameters: z
            .record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.any())]))
            .optional()
            .describe(
              "The upstream tool's own arguments, matching its input schema. Pass each value with its native JSON type (e.g. 25, not {\"value\": 25}). Only that tool's arguments belong here — " +
                ownArgumentsText +
                " passed alongside this object, not inside it. An argument the tool does not declare is refused rather than passed on.",
            ),
          select: z
            .array(z.string())
            .optional()
            .describe(
              "Optional dotted paths to trim the response to — an argument of call_tool itself, passed alongside 'parameters' rather than inside it. For example ['total', 'inventoryItems[*].sku', 'inventoryItems[*].product.title']. '[*]' maps over an array. Nesting is preserved. A path that matches nothing is reported as an error rather than returned as absent data, so a typo cannot look like a missing field. Ignored, with a note, when the tool returns plain text.",
            ),
          ...(confirmEnabled
            ? {
                confirm: z
                  .string()
                  .optional()
                  .describe(
                    "The token from a 'confirmation required' refusal — an argument of call_tool itself, passed alongside 'parameters'. Valid once, for five minutes, and only for the identical call (same tool, same parameters). Pass it only after the user has agreed to the call.",
                  ),
              }
            : {}),
          ...(artefactsEnabled
            ? {
                artefacts: z
                  .string()
                  .min(1)
                  .max(64)
                  .optional()
                  .describe(
                    "Optional label for the task this call belongs to, e.g. 'ebay-weekly-review' — an argument of call_tool itself, passed alongside 'parameters' rather than inside it. Writes the result to a file instead of returning it, and returns { path, bytes, records } — the data never enters your context. Pass the same label on every call in the task and they all land in one directory, whose path comes back as 'dir' for the code that reads them. This is a label, not a path: the directory name is chosen for you. Errors are always returned inline, never written.",
                  ),
              }
            : {}),
        },
      },
      async (args) => {
        const { toolName, parameters = {}, select, artefacts, confirm } = args as {
          toolName: string;
          parameters?: Record<string, unknown>;
          select?: string[];
          artefacts?: string;
          confirm?: string;
        };
        return this.executeCallTool(access, toolName, parameters, { select, artefacts, confirm });
      },
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
  private installToolsListHandler(mcpServer: McpServer, access: ClientAccess): void {
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
        if (indexed && access.permits(name)) {
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
      this.registerPreloadedToolsOnServer(session.mcpServer, passthrough, session.access);
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
  private registerPreloadedToolsOnServer(mcpServer: McpServer, passthrough: z.ZodObject<{}, "passthrough">, access: ClientAccess): void {
    for (const namespaced of this.preloadedToolNames) {
      const indexed = this.index.tools.get(namespaced);
      // Registered at most once per session: recovery re-runs resolvePreloadedTools
      // against live sessions that already have them, and the SDK throws on a
      // duplicate name.
      const registered = (mcpServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
      if (indexed && access.permits(namespaced) && !(namespaced in registered)) {
        mcpServer.registerTool(
          namespaced,
          {
            description: indexed.tool.description,
            inputSchema: passthrough,
          },
          async (args) => this.executeCallTool(access, namespaced, args as Record<string, unknown>, { preloaded: true }),
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

  /**
   * Shared call_tool implementation — also used for preloaded tool dispatch.
   *
   * Every call, refused or not, leaves one line in the call log. Shutdown waits for it
   * through the HTTP request carrying it (see createHttpServer), not here: the call
   * finishing is not the response being written.
   */
  private async executeCallTool(
    access: ClientAccess,
    toolName: string,
    parameters: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<CallToolResult> {
    const started = Date.now();
    const { result, outcome, confirmed } = await this.runCallTool(access, toolName, parameters, options);
    const record: CallRecord = {
      client: access.name,
      tool: toolName,
      outcome,
      ms: Date.now() - started,
      args: Object.keys(parameters).sort(),
      ...(options.select?.length ? { select: options.select.length } : {}),
      ...(options.artefacts ? { artefacts: options.artefacts } : {}),
      ...(confirmed ? { confirmed } : {}),
    };
    logCall(record);
    return result;
  }

  private async runCallTool(
    access: ClientAccess,
    toolName: string,
    parameters: Record<string, unknown>,
    options: CallOptions,
  ): Promise<CallOutcomeResult> {
    const { select, artefacts, confirm } = options;
    const refuse = (outcome: CallOutcome, text: string): CallOutcomeResult => ({
      result: { content: [{ type: "text", text }], isError: true },
      outcome,
    });

    if (!toolName) return refuse("invalid_arguments", "Missing required parameter: toolName");

    const parsed = parseNamespacedName(toolName);
    if (!parsed) {
      return refuse(
        "not_found",
        `Invalid tool name format: ${toolName}. Expected format: <sourceId>__<toolName> (e.g. todoist__get-task)`,
      );
    }

    const source = this.index.sources.get(parsed.sourceId);
    if (!source) return refuse("not_found", `Source not found: ${parsed.sourceId}. Has the nexus been indexed?`);

    // Check the tool exists in our index
    const indexed = this.index.tools.get(toolName);
    if (!indexed) {
      return refuse("not_found", `Tool '${toolName}' not found in nexus. Use browse_tools to see available tools for this service.`);
    }

    // Policy first: a client refused a tool learns nothing about its arguments.
    if (!access.permits(toolName)) {
      return refuse("denied", `Tool '${toolName}' is not available to this client ('${access.name}'). Ask the user to do it, or to change the nexus policy.`);
    }

    // A nexus argument nested inside `parameters` is a caller mistake that would
    // otherwise pass silently, so check before the call rather than after.
    const misplaced = this.checkMisplacedArguments(indexed.tool, parameters);
    if (misplaced.length > 0) {
      const example = misplaced[0] === "select" ? '["field"]' : '"value"';
      return refuse(
        "invalid_arguments",
        JSON.stringify({
          error: `these are arguments of call_tool itself, not parameters of ${toolName}: ${misplaced.join(", ")}`,
          misplaced,
          hint: `move them out of 'parameters' and pass them alongside it — { "toolName": "${toolName}", "parameters": {...}, "${misplaced[0]}": ${example} }`,
        }),
      );
    }

    // Refused here rather than upstream so the refusal can carry the schema — the
    // upstream's own error rarely does, and the fix is always to read it.
    const invalid = validateArguments(toolName, indexed.tool.inputSchema, parameters, {
      allowUnknownArguments: source.config.allowUnknownArguments,
    });
    if (invalid.length > 0) {
      return refuse(
        "invalid_arguments",
        JSON.stringify({
          error: `arguments do not match the input schema of ${toolName}`,
          problems: invalid,
          inputSchema: indexed.tool.inputSchema,
        }),
      );
    }

    // Confirmation comes after validation, so a token is only ever issued for a call
    // that would actually be sent — never for one that was going to be refused anyway.
    const confirmation = access.confirmationReason(toolName, indexed.tool);
    let confirmed: true | undefined;
    if (confirmation) {
      if (confirm && this.confirmations.redeem(confirm, access.name, toolName, parameters)) {
        confirmed = true;
      } else {
        const token = this.confirmations.issue(access.name, toolName, parameters);
        return refuse(
          "confirmation_required",
          JSON.stringify({
            error: `confirmation required: ${confirmation}`,
            confirm: token,
            expiresInSeconds: 300,
            ...(confirm ? { rejected: "the confirm token passed was expired, already used, or issued for a different call" } : {}),
            hint: options.preloaded
              ? `tell the user exactly what this call will do and wait for their go-ahead, then make it through call_tool: { "toolName": "${toolName}", "parameters": <the same parameters>, "confirm": "${token}" }`
              : `tell the user exactly what this call will do and wait for their go-ahead, then repeat the identical call with "confirm": "${token}" alongside 'parameters'`,
          }),
        );
      }
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

      return refuse(
        "transport_error",
        JSON.stringify({ error: result.error, source: parsed.sourceId, tool: toolName, staleSchemaRefreshed: isStaleSchema }),
      );
    }

    // Clear transport error state — the call reached the service (A3)
    if (source.lastError) {
      source.lastError = undefined;
      this.index.failedSources.delete(parsed.sourceId);
    }

    // A tool-level failure is forwarded as a failure. Previously it was stringified
    // into a successful-looking blob, so callers could not tell a result from an error.
    if (result.isError) {
      await this.refreshIfStaleSchema(parsed.sourceId, textOf(result.content));
      return { result: { content: minifyContent(result.content) as CallToolResult["content"], isError: true }, outcome: "tool_error" };
    }

    const done = (callResult: CallToolResult): CallOutcomeResult => ({
      result: callResult,
      outcome: callResult.isError ? "artefact_error" : "ok",
      confirmed,
    });

    // Resolve the JSON payload once — structuredContent when the service declares an
    // outputSchema, otherwise the first text block that parses as JSON.
    const jsonBlock = resolveJsonBlock(result.content);
    const payload = result.structuredContent ?? jsonBlock?.data;

    // Record the shape of the *full* payload before any trimming, so get_schemas can
    // hand it to a caller that has not seen a response yet.
    if (payload !== undefined) this.responseShapes.set(toolName, inferShape(payload));

    // An empty array means "I am not selecting anything", not "select nothing".
    const paths = select && select.length > 0 ? select : undefined;
    const passthrough = minifyContent(result.content);

    if (!paths) {
      if (artefacts) return done(this.writeArtefactResult(artefacts, parsed.toolName, parameters, select, payload, passthrough, []));
      return done({ content: passthrough as CallToolResult["content"], structuredContent: result.structuredContent });
    }

    // A text response has nothing to select from. It used to be refused after the call
    // had run, so the result was thrown away and the caller had to make the call again
    // — for Todoist, whose task tools all return text, on every call with a select.
    // The text is returned as it came, with a note, since the call has already been made.
    if (payload === undefined) {
      const note = `'select' was ignored: ${toolName} returned text, not JSON, so there were no paths to select from. The full response is above.`;
      if (artefacts) return done(this.writeArtefactResult(artefacts, parsed.toolName, parameters, select, payload, passthrough, [note]));
      return done({ content: [...passthrough, { type: "text", text: `Note: ${note}` }] as CallToolResult["content"] });
    }

    const { result: selected, unmatched } = selectPaths(payload, paths);

    // A path that matches nothing is a caller error, not an empty result — returning
    // the trimmed data anyway would make a typo indistinguishable from absent data.
    if (unmatched.length > 0) {
      // Narrowed to the branch the failed paths were reaching into — the full shape of a
      // wide response can cost many times the response the caller was asking for.
      const { paths: shape, omitted } = relevantShape(this.responseShapes.get(toolName) ?? [], unmatched);

      return refuse(
        "invalid_arguments",
        JSON.stringify({
          error: `select paths matched nothing on ${toolName}`,
          unmatched,
          responseShape: shape,
          responseShapeOmitted: omitted || undefined,
          hint: omitted > 0 ? `call get_schemas for the full response shape of ${toolName}` : undefined,
        }),
      );
    }

    const content = replaceJsonBlock(result.content, result.structuredContent ? -1 : (jsonBlock?.index ?? -1), selected);

    if (artefacts) return done(this.writeArtefactResult(artefacts, parsed.toolName, parameters, select, selected, content, []));

    return done({
      content: content as CallToolResult["content"],
      structuredContent: result.structuredContent ? (selected as Record<string, unknown>) : undefined,
    });
  }

  /**
   * Write a successful result to the artefacts directory and return a receipt.
   *
   * Only reached on success: transport errors, upstream tool failures and unmatched
   * `select` paths have all returned inline before this point, because an error
   * written to a file is an error nobody reads.
   */
  private writeArtefactResult(
    label: string,
    toolName: string,
    parameters: Record<string, unknown>,
    select: string[] | undefined,
    payload: unknown,
    content: ContentBlock[],
    notes: string[],
  ): CallToolResult {
    const config = this.config.artefacts;
    if (!config) {
      return {
        content: [{ type: "text", text: "This nexus has no artefacts root configured, so 'artefacts' cannot be used. Retry without it." }],
        isError: true,
      };
    }

    const text = payload === undefined ? textOf(content) : "";
    if (payload === undefined && text.trim() === "") {
      return {
        content: [{ type: "text", text: `Nothing to write for ${toolName}: the response carried no JSON payload and no text. Retry without 'artefacts'.` }],
        isError: true,
      };
    }

    let artefact: ArtefactResult;
    try {
      const run = resolveRun(config, label);
      artefact = writeArtefact(config, run, { toolName, parameters, select, payload, text });
    } catch (err) {
      // Deliberately not falling back to returning the payload: a disk failure on a
      // wide response would put the whole thing into context at exactly the moment
      // the caller was trying to keep it out — and would do so on every page at once.
      const code = (err as NodeJS.ErrnoException).code;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `could not write artefact for ${toolName}`,
              reason: err instanceof Error ? err.message : String(err),
              code,
              root: config.root,
              hint: "the result was not returned and not saved — fix the artefacts mount and retry",
            }),
          },
        ],
        isError: true,
      };
    }

    // Anything that is not text (images, embedded resources) has no file
    // representation here, so it still rides back inline alongside the receipt.
    const nonText = content.filter((block) => block.type !== "text");

    return {
      content: [
        { type: "text", text: JSON.stringify({ artefact, notes: notes.length > 0 ? notes : undefined }) },
        ...nonText,
      ] as CallToolResult["content"],
    };
  }

  /**
   * Detect call_tool's own arguments nested inside `parameters`.
   *
   * `parameters` is an open record, so `{ parameters: { limit: 25, select: [...] } }`
   * validates and the stray key is forwarded upstream. The service then ignores it,
   * and the caller believes a selection was applied that never reached the nexus at
   * all — a wrong answer with nothing to show it was wrong, which is the failure
   * `select`'s unmatched-path error exists to prevent. The unknown-argument check in
   * validation would also refuse it, but this names the actual mistake.
   *
   * Checked against the upstream tool's declared properties rather than by name
   * alone, so a service with a genuine parameter called `select` still works. A tool
   * declaring no properties is left alone: there is nothing to check it against, and
   * guessing would break open-schema tools that accept arbitrary keys.
   */
  private checkMisplacedArguments(tool: McpTool, parameters: Record<string, unknown>): string[] {
    const declared = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!declared || typeof declared !== "object") return [];

    return NEXUS_CALL_ARGS.filter((name) => name in parameters && !(name in declared));
  }

  /**
   * Re-index a source when an error suggests our cached schema is out of date.
   *
   * Only unambiguous signals qualify here. A tool-level "invalid params" is almost
   * always a malformed call rather than a stale schema, and re-indexing the whole
   * source on every bad argument would be a needless round trip per mistake — that
   * heuristic stays on the transport-error path, where it means the JSON-RPC method
   * itself was rejected.
   */
  private async refreshIfStaleSchema(sourceId: string, message: string): Promise<void> {
    const lowered = message.toLowerCase();
    if (!message.includes("-32601") && !lowered.includes("method not found")) return;

    logger.info(`Stale schema detected for ${sourceId}, triggering re-index...`);
    await this.refreshSource(sourceId);
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
        // A search running lexically when it was configured to use meaning is degraded
        // too: every query still answers, just worse, which nothing else would show.
        const search = this.searchEngine.status();
        const searchDegraded = search.semantic === "unavailable" || search.semantic === "failing";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: failed === 0 && !searchDegraded ? "ok" : "degraded",
            uptime: process.uptime(),
            sources: { total: sources.length, available, failed },
            failedSourceIds: failed > 0 ? Array.from(this.index.failedSources) : undefined,
            totalTools: this.index.tools.size,
            search,
          }),
        );
        return;
      }

      // Auth check — also says which client this is (`anonymous` when auth is off)
      const client = authenticate(req.headers["authorization"], this.config.auth);
      if (client === null) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }

      if (req.method === "POST") {
        if (this.closing) {
          sendJsonRpcError(res, 503, -32000, "mcp-nexus is shutting down; retry in a few seconds");
          return;
        }
        // Tracked until the response is fully written, which is what shutdown has to
        // wait for — a tool call returning is not its result reaching the client.
        // GET streams are left out: they stay open by design and would hold every stop
        // to the full drain timeout.
        const finished = new Promise<void>((resolve) => res.once("close", () => resolve()));
        this.inFlight.add(finished);
        void finished.then(() => this.inFlight.delete(finished));
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
      await this.handleMcpRequest(req, wrapped, parsedBody, client);
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
  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse, parsedBody: unknown, client: string): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Case 1: Existing session — reuse its transport
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      // The session's tools are bound to the client that opened it. Another client's
      // valid token with this session's ID would otherwise call with that client's
      // policy and be logged under its name.
      if (session.access.name !== client) {
        sendJsonRpcError(res, 403, -32001, "Forbidden: this session belongs to another client");
        return;
      }
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
          this.sessions.set(sid, { transport, mcpServer, access });
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
      // Instructions are rendered here, not at startup: this runs inside the
      // initialize handler, so the roster reflects the index as it stands when
      // the client actually connects.
      const access = ClientAccess.for(client, this.config.auth);
      const mcpServer = new McpServer(
        { name: "mcp-nexus", version: SERVER_VERSION },
        { capabilities: { tools: { listChanged: true } }, instructions: this.renderInstructions(access) },
      );
      this.registerNexusTools(mcpServer, access);
      this.installToolsListHandler(mcpServer, access);

      // Register any preloaded tools that were resolved before this session
      if (this.preloadedToolNames.size > 0) {
        this.registerPreloadedToolsOnServer(mcpServer, z.object({}).passthrough(), access);
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

  /**
   * Start listening. Resolves with the bound port, which differs from the configured
   * one only when that is 0 — how a test asks for any free port.
   */
  async start(): Promise<number> {
    // No transport to connect at startup — sessions are created on demand
    // when clients send initialize requests.
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        const port = (this.httpServer.address() as AddressInfo).port;
        logger.info(`mcp-nexus listening on port ${port}`);
        logger.info(`  MCP endpoint: POST http://0.0.0.0:${port}/`);
        logger.info(`  Health check: GET  http://0.0.0.0:${port}/health`);
        resolve(port);
      });
    });
  }

  /**
   * Stop taking calls, let the ones in flight finish, then close the sessions.
   *
   * The caller kills stdio children and pooled HTTP connections once this resolves.
   * It used to do that while calls were still waiting on them, so a call in progress
   * at a restart failed with "Subprocess exited" — after the upstream may already
   * have acted on it. The drain is bounded so a hung upstream cannot hold up a stop.
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down...");
    this.closing = true;
    // Stop accepting connections; idle keep-alive sockets would otherwise hold close() open.
    const closed = new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    this.httpServer.closeIdleConnections();

    if (this.inFlight.size > 0) {
      logger.info(`Waiting up to ${SHUTDOWN_DRAIN_MS / 1000}s for ${this.inFlight.size} request(s) in flight`);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS);
      });
      const drained = Promise.allSettled([...this.inFlight]).then(() => "drained" as const);
      const outcome = await Promise.race([drained, timeout]);
      clearTimeout(timer);
      if (outcome === "timeout") logger.warn(`${this.inFlight.size} request(s) still running at shutdown - abandoning them`);
    }

    // Close all active sessions
    for (const [sid, session] of this.sessions) {
      try {
        await session.mcpServer.close();
      } catch {
        // Session may already be closed — ignore
      }
      this.sessions.delete(sid);
    }
    this.httpServer.closeAllConnections();
    await closed;
    logger.info("HTTP server closed");
  }
}
