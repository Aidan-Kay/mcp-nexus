/** Stdio transport client — spawns a subprocess and communicates over stdin/stdout */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { applyFilter } from "../glob-utils.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../indexer.js";
import { sourceLogger } from "../logger.js";
import type { JsonRpcRequest, JsonRpcResponse, SourceConfig } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };
const CLIENT_VERSION = pkg.version;

// ─── Process Manager ────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface StdioSession {
  process: ChildProcess;
  pending: Map<string, PendingRequest>;
  rl: ReturnType<typeof createInterface>;
  initialized: boolean;
  /** In-flight initialize handshake, used to dedupe concurrent callers. */
  initializing?: Promise<void>;
  /** Pending stdin payloads, flushed one at a time to avoid interleaving. */
  writeQueue: string[];
  /** True while the write queue is being drained. */
  flushing: boolean;
}

let reqCounter = 0;
function nextId(): string {
  return `nexus-${++reqCounter}`;
}

const sessions = new Map<string, StdioSession>();

/**
 * Queue a payload for stdin and flush serially. OS pipe writes are only atomic
 * up to PIPE_BUF; issuing concurrent writes for large payloads can interleave
 * their bytes and corrupt the JSON-RPC line stream. Waiting for each write's
 * callback before sending the next guarantees one message is fully flushed
 * before the next begins.
 */
function enqueueWrite(session: StdioSession, payload: string): void {
  session.writeQueue.push(payload);
  if (session.flushing) return;
  session.flushing = true;
  const stdin = session.process.stdin!;
  const pump = (): void => {
    const next = session.writeQueue.shift();
    if (next === undefined) {
      session.flushing = false;
      return;
    }
    stdin.write(next, () => pump());
  };
  pump();
}

function spawnProcess(config: SourceConfig): StdioSession {
  if (!config.command) {
    throw new Error(`No command configured for stdio source ${config.id}`);
  }

  const slog = sourceLogger(config.id);
  slog.info(`spawning ${config.command}`);

  // Build minimal env: PATH + HOME + config.env only — NOT process.env.
  // Inheriting process.env leaks secrets, locale settings, and other host
  // state into the child process (S4).
  const childEnv: Record<string, string> = {};
  if (process.env.PATH) childEnv.PATH = process.env.PATH;
  if (process.env.HOME) childEnv.HOME = process.env.HOME;
  if (process.env.USERPROFILE) childEnv.USERPROFILE = process.env.USERPROFILE;
  if (process.env.TEMP) childEnv.TEMP = process.env.TEMP;
  if (process.env.TMP) childEnv.TMP = process.env.TMP;
  if (config.env) Object.assign(childEnv, config.env);

  const proc = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const pending = new Map<string, PendingRequest>();
  const rl = createInterface({ input: proc.stdout! });

  // Drain stderr to prevent pipe buffer from filling and hanging the child.
  // Logged at debug level since upstream servers may echo secrets/config here.
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trimEnd();
    if (text) {
      slog.debug(`stderr: ${text}`);
    }
  });

  const session: StdioSession = {
    process: proc,
    pending,
    rl,
    initialized: false,
    writeQueue: [],
    flushing: false,
  };

  rl.on("line", (line: string) => {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line);
    } catch {
      slog.warn(`invalid JSON from subprocess — ${line.slice(0, 100)}`);
      return;
    }
    const pendingReq = pending.get(parsed.id);
    if (pendingReq) {
      clearTimeout(pendingReq.timer);
      pending.delete(parsed.id);
      pendingReq.resolve(parsed);
    }
  });

  proc.on("error", (err) => {
    slog.error(`process error — ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    slog.warn(`exited code=${code} signal=${signal}`);
    // Reject all pending
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`Subprocess exited (code=${code})`));
    }
    pending.clear();
    sessions.delete(config.id);
  });

  sessions.set(config.id, session);
  return session;
}

function getOrSpawn(config: SourceConfig): StdioSession {
  let session = sessions.get(config.id);
  if (!session || session.process.killed) {
    session = spawnProcess(config);
  }
  return session;
}

// ─── Send JSON-RPC ──────────────────────────────────────────────────────────

function sendRequest(config: SourceConfig, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const session = getOrSpawn(config);
    const id = nextId();
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    session.pending.set(id, { resolve, reject, timer });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    enqueueWrite(session, JSON.stringify(request) + "\n");
  });
}

// ─── MCP Initialize Handshake ───────────────────────────────────────────────

/**
 * Perform the MCP initialize handshake if not yet done for this session.
 * Sends initialize, captures server info, then sends notifications/initialized.
 */
async function ensureInitialized(config: SourceConfig): Promise<void> {
  const session = getOrSpawn(config);
  if (session.initialized) return;
  // Dedupe concurrent handshakes: reuse the in-flight initialize promise.
  if (session.initializing) return session.initializing;

  session.initializing = (async () => {
    const slog = sourceLogger(config.id);
    slog.info("performing MCP initialize handshake");

    const response = await sendRequest(config, "initialize", {
      protocolVersion: "2025-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-nexus", version: CLIENT_VERSION },
    });

    if (response.error) {
      throw new Error(`Initialize failed for ${config.id}: ${response.error.message}`);
    }

    session.initialized = true;

    // Send initialized notification (no id, no response expected)
    sendRequestNoWait(config, "notifications/initialized");
  })();

  try {
    await session.initializing;
  } finally {
    session.initializing = undefined;
  }
}

/**
 * Send a JSON-RPC notification (fire-and-forget, no response tracking).
 * Used for notifications/initialized which must not have an id.
 */
function sendRequestNoWait(config: SourceConfig, method: string, params?: Record<string, unknown>): void {
  try {
    const session = getOrSpawn(config);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
    };
    enqueueWrite(session, JSON.stringify(request) + "\n");
  } catch {
    // fire-and-forget — ignore errors
  }
}

/** Send a request with automatic initialize handshake */
async function sendWithInitialize(config: SourceConfig, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  await ensureInitialized(config);
  return sendRequest(config, method, params);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Fetch tools from an upstream MCP server via stdio transport */
export async function fetchTools(config: SourceConfig): Promise<{ tools: Tool[]; error?: string }> {
  if (!config.command) {
    return { tools: [], error: "No command configured for stdio source" };
  }

  const slog = sourceLogger(config.id);

  try {
    const response = await sendWithInitialize(config, "tools/list", {});

    if (response.error) {
      return { tools: [], error: response.error.message };
    }

    const result = response.result as { tools?: Tool[] } | undefined;
    const tools = result?.tools ?? [];

    // Apply glob filter if configured
    const filtered = config.filter && config.filter.length > 0 ? applyFilter(tools, config.filter) : tools;

    slog.info(`fetched ${filtered.length}/${tools.length} tools`);
    return { tools: filtered };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tools: [], error: msg };
  }
}

/** Call a tool on an upstream MCP server via stdio transport */
export async function callTool(
  config: SourceConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError?: boolean; error?: string }> {
  if (!config.command) {
    return { content: [], error: "No command configured for stdio source" };
  }

  try {
    const response = await sendWithInitialize(config, "tools/call", {
      name: toolName,
      arguments: args,
    });

    if (response.error) {
      return { content: [], isError: true, error: response.error.message };
    }

    return { content: response.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [], isError: true, error: msg };
  }
}

/** Kill and cleanup a stdio subprocess */
export function killSource(sourceId: string): void {
  const session = sessions.get(sourceId);
  if (session) {
    session.process.kill();
    sessions.delete(sourceId);
  }
}

/** Kill all stdio subprocesses */
export function killAll(): void {
  for (const [id] of sessions) {
    killSource(id);
  }
}
