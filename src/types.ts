/** Core types for mcp-nexus */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NexusConfig {
  port: number;
  auth: AuthConfig;
  connectors: ConnectorsConfig;
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

export type SourceType = "gateway" | "server";
export type TransportType = "http" | "stdio";

export interface SourceConfig {
  id: string;
  name: string;
  description: string;
  type: SourceType;
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
}

export interface IndexedTool {
  sourceId: string;
  namespacedName: string;
  tool: Tool;
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
