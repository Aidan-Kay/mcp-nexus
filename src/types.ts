/** Core types for mcp-nexus */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock } from "./response.js";
import type { SearchConfig } from "./search/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NexusConfig {
  port: number;
  auth: AuthConfig;
  connectors: ConnectorsConfig;
  search: SearchConfig;
  sources: SourceConfig[];
  /** Absent = artefact writing is off, and `call_tool` does not advertise it */
  artefacts?: ArtefactsConfig;
}

export interface AuthConfig {
  enabled: boolean;
  /** The shared token, from MCP_NEXUS_AUTH_TOKEN. Callers presenting it are the client `default`. */
  token: string;
  /**
   * Per-client tokens, from MCP_NEXUS_TOKEN_<NAME>, keyed by the lowercased name.
   * Never read from the YAML: a token in a config file is one more copy of a secret.
   */
  clientTokens: Record<string, string>;
  /** What each client may call, keyed by client name. A client without an entry may call anything. */
  clients: Record<string, ClientPolicy>;
  /** When set, only these origins are echoed in CORS headers. Empty/unset = reflect any origin. */
  allowedOrigins?: string[];
}

/**
 * One client's policy. Every pattern is a glob over namespaced tool names
 * (`ebay__*`, `*__delete*`), so a service and a single tool are written the same way.
 */
export interface ClientPolicy {
  /** When set, only matching tools are visible or callable. */
  allow?: string[];
  /** Matching tools are neither visible nor callable. Wins over `allow`. */
  deny?: string[];
  /** Matching tools need a confirmed second call (see `confirmDestructive`). */
  confirm?: string[];
  /** Also require confirmation for every tool its upstream annotates `destructiveHint: true`. */
  confirmDestructive: boolean;
}

export interface ConnectorsConfig {
  /** Idle timeout (seconds) before a cached upstream HTTP session is reaped. */
  httpReuseIdleTimeoutSeconds: number;
  /** Interval (seconds) between recovery probes for failed sources. 0 = disabled. */
  recoveryIntervalSeconds: number;
  /** An upstream response larger than this is abandoned rather than buffered. */
  maxResponseBytes: number;
}

export interface ArtefactsConfig {
  /** Directory every artefact is written under. Nexus owns everything below it. */
  root: string;
  /** Delete run directories older than this. 0 = never prune. */
  retentionDays: number;
  /** How long an `artefacts` label keeps resolving to the same run directory. */
  runIdleMinutes: number;
  /** Refuse to write a single artefact larger than this. */
  maxBytes: number;
}

export type TransportType = "http" | "stdio";

export interface SourceConfig {
  id: string;
  name: string;
  description: string;
  transport: TransportType;
  /** HTTP URL (required for http transport) */
  url?: string;
  /** Optional glob filters — only expose tools matching these patterns */
  filter?: string[];
  /** Stdio: command to execute (required for stdio transport) */
  command?: string;
  /** Stdio: command arguments */
  args?: string[];
  /** Stdio: working directory */
  cwd?: string;
  /** Stdio: additional environment variables */
  env?: Record<string, string>;
  /** Non-prefixed tool names (e.g. "get-task") to surface directly in tools/list */
  preloadedTools?: string[];
  /**
   * Let arguments the tool's schema does not declare through to the upstream. Off by
   * default: a misspelled filter that reaches the service is ignored there, and the
   * caller gets every record back with nothing to say its filter never applied.
   */
  allowUnknownArguments?: boolean;
  /** Per-source request timeout in milliseconds (default: 15000) */
  requestTimeoutMs?: number;
}

// ─── Runtime State ──────────────────────────────────────────────────────────

export interface SourceState {
  config: SourceConfig;
  tools: Tool[];
  /** HTTP client for Streamable HTTP (http transport only) */
  httpClient?: HttpSession;
  /** Subprocess handle (stdio transport only) */
  stdioProcess?: StdioSession;
  lastError?: string;
  lastChecked: number;
}

export interface HttpSession {
  url: string;
}

export interface StdioSession {
  /** Write JSON-RPC to stdin, read from stdout */
  write: (data: string) => void;
  kill: () => void;
}

// ─── Index ───────────────────────────────────────────────────────────────────

export interface NexusIndex {
  /** All registered sources, keyed by source id */
  sources: Map<string, SourceState>;
  /** Flat map: namespaced tool name → { sourceId, tool } */
  tools: Map<string, IndexedTool>;
  /** Pre-indexed tools grouped by sourceId — O(1) lookup for browse_tools */
  toolsBySource: Map<string, IndexedTool[]>;
  /** Set of source IDs that have a lastError — O(1) lookup for recovery poller */
  failedSources: Set<string>;
  /** Tool embeddings for semantic search (namespacedName → vector) */
  embeddings?: Map<string, Float32Array>;
}

export interface IndexedTool {
  sourceId: string;
  namespacedName: string;
  tool: Tool;
}

// ─── JSON-RPC Types (shared between http-source and stdio-source) ────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Upstream Call Result (consistent return type for callTool) ─────────────

export interface UpstreamCallResult {
  /** Content blocks lifted out of the upstream CallToolResult — never the envelope itself */
  content: ContentBlock[];
  /** Structured payload, when the upstream tool declares an outputSchema */
  structuredContent?: Record<string, unknown>;
  /** Upstream signalled a tool-level failure (CallToolResult.isError) */
  isError?: boolean;
  /** Transport- or protocol-level failure — distinct from a tool-level isError */
  error?: string;
}

// ─── Error Wrapping ─────────────────────────────────────────────────────────

export interface NexusError {
  code: number;
  message: string;
  source?: string;
  tool?: string;
  upstream?: unknown;
}

export function isNexusError(e: unknown): e is NexusError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}
