/** Core types for mcp-nexus */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SearchConfig } from "./search/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NexusConfig {
  port: number;
  auth: AuthConfig;
  connectors: ConnectorsConfig;
  search: SearchConfig;
  sources: SourceConfig[];
}

export interface AuthConfig {
  enabled: boolean;
  token: string;
  /** When set, only these origins are echoed in CORS headers. Empty/unset = reflect any origin. */
  allowedOrigins?: string[];
}

export interface ConnectorsConfig {
  /** Idle timeout (seconds) before a cached upstream HTTP session is reaped. */
  httpReuseIdleTimeoutSeconds: number;
  /** Interval (seconds) between recovery probes for failed sources. 0 = disabled. */
  recoveryIntervalSeconds: number;
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
  content: unknown;
  isError?: boolean;
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
