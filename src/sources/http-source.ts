/** HTTP transport client for MCP Streamable HTTP (2025-11-05)
 *
 * Handles the full MCP lifecycle:
 *   1. initialize → get sessionId
 *   2. tools/list (with sessionId header)
 *   3. tools/call (with sessionId header)
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest, RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFilter } from "../glob-utils.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../indexer.js";
import { logger, sourceLogger } from "../logger.js";
import type { JsonRpcRequest, JsonRpcResponse, SourceConfig } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };
const CLIENT_VERSION = pkg.version;

// ─── Session State ───────────────────────────────────────────────────────────

interface SessionState {
  sessionId: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  /** Unix ms of last activity — used by the idle reaper. */
  lastUsed: number;
}

const sessions = new Map<string, SessionState>();

// In-flight initialize promises, keyed by source id, to dedupe concurrent cold starts.
const pendingInits = new Map<string, Promise<string | null>>();

// One keep-alive agent per source, reused across requests for connection pooling.
const agents = new Map<string, HttpAgent | HttpsAgent>();

function getAgent(config: SourceConfig): HttpAgent | HttpsAgent {
  let agent = agents.get(config.id);
  if (!agent) {
    const isHttps = (config.url ?? "").startsWith("https://");
    agent = isHttps ? new HttpsAgent({ keepAlive: true, maxSockets: 8 }) : new HttpAgent({ keepAlive: true, maxSockets: 8 });
    agents.set(config.id, agent);
  }
  return agent;
}

function touchSession(sourceId: string): void {
  const s = sessions.get(sourceId);
  if (s) s.lastUsed = Date.now();
}

// ─── Idle Session Reaper ──────────────────────────────────────────────────────

let idleTimeoutMs = 300_000; // default 5 min; overridden by configureHttpConnector
let reaperTimer: NodeJS.Timeout | undefined;

/** Configure HTTP connection reuse and start the idle-session reaper. */
export function configureHttpConnector(idleTimeoutSeconds: number): void {
  idleTimeoutMs = idleTimeoutSeconds * 1000;
  if (reaperTimer) return;
  reaperTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [id, s] of sessions) {
        if (now - s.lastUsed >= idleTimeoutMs) {
          logger.info(`HTTP source ${id}: session idle ${Math.round((now - s.lastUsed) / 1000)}s, reaping`);
          sessions.delete(id);
          agents.get(id)?.destroy();
          agents.delete(id);
        }
      }
    },
    Math.max(30_000, Math.min(idleTimeoutMs, 60_000)),
  );
  // Don't keep the event loop alive solely for the reaper.
  reaperTimer.unref?.();
}

/** Stop the reaper and tear down all pooled connections (called on shutdown). */
export function shutdownHttp(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = undefined;
  }
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
  sessions.clear();
}

let reqCounter = 0;
function nextId(): string {
  return `nexus-${++reqCounter}`;
}

// ─── HTTP Request ───────────────────────────────────────────────────────────

function sendJsonRpc(
  url: string,
  body: JsonRpcRequest,
  sessionId?: string,
  signal?: AbortSignal,
  agent?: HttpAgent | HttpsAgent,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ response: JsonRpcResponse; newSessionId?: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const requester = isHttps ? httpsRequest : httpRequest;

    const parsedUrl = new URL(url);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "mcp-nexus/1.0",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    const options: RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers,
      timeout: timeoutMs,
      signal,
      agent,
    };

    const req = requester(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        // Capture session ID from response headers
        const newSessionId = typeof res.headers["mcp-session-id"] === "string" ? (res.headers["mcp-session-id"] as string) : undefined;
        // Some MCP servers (e.g. plex-mcp) return SSE format even over HTTP:
        //   event: message\n
        //   data: {"jsonrpc":"2.0","id":"...","result":{...}}\n\n
        // Detect SSE and extract the first JSON payload from a "data:" line.
        let parsed: JsonRpcResponse | null = null;
        try {
          parsed = JSON.parse(raw) as JsonRpcResponse;
        } catch {
          // Not plain JSON — try SSE extraction
          const dataLines: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
            }
          }
          if (dataLines.length > 0) {
            const joined = dataLines.join("");
            try {
              parsed = JSON.parse(joined) as JsonRpcResponse;
            } catch {
              reject(new Error(`Invalid JSON in SSE data: ${joined.slice(0, 200)}`));
              return;
            }
          } else {
            reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
            return;
          }
        }
        resolve({ response: parsed, newSessionId });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Fire-and-forget JSON-RPC notification (no id, no response parsing).
 * Used for notifications/initialized, which the server ACKs with an empty body.
 */
function sendNotification(
  url: string,
  body: JsonRpcRequest,
  sessionId: string,
  agent?: HttpAgent | HttpsAgent,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): void {
  try {
    const isHttps = url.startsWith("https://");
    const requester = isHttps ? httpsRequest : httpRequest;
    const parsedUrl = new URL(url);
    const req = requester({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "mcp-nexus/1.0",
        "mcp-session-id": sessionId,
      },
      timeout: timeoutMs,
      agent,
    });
    // Drain and discard any response so the socket can be reused by keep-alive.
    req.on("response", (res) => res.resume());
    req.on("error", () => {});
    req.write(JSON.stringify(body));
    req.end();
  } catch {
    // fire-and-forget — ignore errors
  }
}

// ─── Initialize ─────────────────────────────────────────────────────────────

async function ensureSession(config: SourceConfig): Promise<string | null> {
  if (!config.url) return null;

  const existing = sessions.get(config.id);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }

  // Dedupe concurrent cold starts: reuse an in-flight initialize.
  const inflight = pendingInits.get(config.id);
  if (inflight) return inflight;

  const initPromise = initSession(config);
  pendingInits.set(config.id, initPromise);
  try {
    return await initPromise;
  } finally {
    pendingInits.delete(config.id);
  }
}

async function initSession(config: SourceConfig): Promise<string | null> {
  if (!config.url) return null;

  const slog = sourceLogger(config.id);
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  slog.info("initializing session");

  const agent = getAgent(config);
  const { response, newSessionId } = await sendJsonRpc(
    config.url,
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-nexus", version: CLIENT_VERSION },
      },
    },
    undefined,
    undefined,
    agent,
    timeoutMs,
  );

  if (response.error) {
    throw new Error(`Initialize failed: ${response.error.message}`);
  }

  const result = response.result as
    | {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      }
    | undefined;

  if (!result) {
    throw new Error("Initialize returned no result");
  }

  if (!newSessionId) {
    throw new Error("No session ID returned from initialize");
  }

  sessions.set(config.id, {
    sessionId: newSessionId,
    serverInfo: result.serverInfo,
    capabilities: result.capabilities,
    lastUsed: Date.now(),
  });

  slog.info(`session established (${result.serverInfo.name} ${result.serverInfo.version})`);

  // Send initialized notification (fire-and-forget, must omit id per JSON-RPC spec)
  sendNotification(
    config.url,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    newSessionId,
    agent,
    timeoutMs,
  );

  return newSessionId;
}

// ─── Session-aware Request with Auto-Revalidation ──────────────────────────

/**
 * Send a JSON-RPC request with automatic session revalidation on stale-session
 * errors. If the upstream returns a session-related error (or HTTP 404), the
 * cached session is cleared, a new session is established, and the request is
 * retried exactly once before giving up.
 */
async function sendWithRetry(
  config: SourceConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<{ response: JsonRpcResponse; error?: string }> {
  if (!config.url) return { response: { jsonrpc: "2.0", id: "" }, error: "No URL configured" };

  const slog = sourceLogger(config.id);
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const sessionId = await ensureSession(config);
    if (!sessionId) return { response: { jsonrpc: "2.0", id: "" }, error: "No URL configured" };

    try {
      const { response } = await sendJsonRpc(
        config.url,
        {
          jsonrpc: "2.0",
          id: nextId(),
          method,
          params,
        },
        sessionId,
        undefined,
        getAgent(config),
        timeoutMs,
      );

      touchSession(config.id);

      if (!response.error) return { response };

      // Check if error looks like a stale/expired session
      const isSessionError = response.error.code === -32001 || (response.error.message ?? "").toLowerCase().includes("session");

      if (isSessionError && attempt === 1) {
        slog.info("session expired, re-initializing...");
        sessions.delete(config.id);
        continue; // retry with fresh session
      }

      return { response, error: response.error.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Transient network error — retry once
      if (attempt === 1) {
        slog.info(`request failed (${msg}), retrying with fresh session...`);
        sessions.delete(config.id);
        continue;
      }
      return { response: { jsonrpc: "2.0", id: "" }, error: msg };
    }
  }

  return { response: { jsonrpc: "2.0", id: "" }, error: "Request failed after retry" };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Fetch tools from an upstream MCP server via HTTP transport */
export async function fetchTools(config: SourceConfig): Promise<{ tools: Tool[]; error?: string }> {
  if (!config.url) {
    return { tools: [], error: "No URL configured for HTTP source" };
  }

  const slog = sourceLogger(config.id);

  try {
    const { response, error } = await sendWithRetry(config, "tools/list", {});

    if (error) {
      return { tools: [], error };
    }

    const result = response.result as { tools?: Tool[] } | undefined;
    const tools = result?.tools ?? [];

    // Apply glob filter if configured
    const filtered = config.filter && config.filter.length > 0 ? applyFilter(tools, config.filter) : tools;

    slog.info(`fetched ${filtered.length}/${tools.length} tools`);
    return { tools: filtered };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sessions.delete(config.id);
    return { tools: [], error: msg };
  }
}

/** Call a tool on an upstream MCP server via HTTP transport */
export async function callTool(
  config: SourceConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError?: boolean; error?: string }> {
  if (!config.url) {
    return { content: [], error: "No URL configured for HTTP source" };
  }

  try {
    const { response, error } = await sendWithRetry(config, "tools/call", {
      name: toolName,
      arguments: args,
    });

    if (error) {
      return { content: [], isError: true, error };
    }

    return { content: response.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sessions.delete(config.id);
    return { content: [], isError: true, error: msg };
  }
}
