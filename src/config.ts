/**
 * YAML config loader with Zod validation.
 *
 * Every object in the schema is strict: a key it does not know is a startup error,
 * not something to drop. Dropping them silently is how `type: gateway` sat in every
 * deployed config for months after the field was removed, read by nothing, while
 * whoever wrote it believed it meant something. A misspelt key fails the same way.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { compileFilterPatterns } from "./glob-utils.js";
import { logger } from "./logger.js";
import type { NexusConfig } from "./types.js";

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const SourceConfigSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    description: z.string().max(512).default(""),
    transport: z.enum(["http", "stdio"]),
    url: z.string().url().optional(),
    filter: z.array(z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    preloadedTools: z.array(z.string()).optional(),
    allowUnknownArguments: z.boolean().optional(),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Enforce transport-specific required fields at validation time
    if (s.transport === "http" && !s.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `http transport requires 'url' (source '${s.id}')`,
        path: ["url"],
      });
    }
    if (s.transport === "stdio" && !s.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stdio transport requires 'command' (source '${s.id}')`,
        path: ["command"],
      });
    }
  });

const PatternListSchema = z.array(z.string().min(1)).optional();

const ClientPolicySchema = z
  .object({
    allow: PatternListSchema,
    deny: PatternListSchema,
    confirm: PatternListSchema,
    confirmDestructive: z.boolean().default(false),
  })
  .strict();

/** A client name as it appears in MCP_NEXUS_TOKEN_<NAME>, lowercased. */
const CLIENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const AuthConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    token: z.string().default(""),
    clients: z
      .record(ClientPolicySchema)
      .default({})
      .superRefine((clients, ctx) => {
        for (const name of Object.keys(clients)) {
          if (!CLIENT_NAME.test(name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `client name '${name}' must match ${CLIENT_NAME}`, path: [name] });
          }
        }
      }),
    /** When set, only these origins are echoed in CORS headers. Empty/unset = reflect any origin. */
    allowedOrigins: z.array(z.string()).optional(),
  })
  .strict();

/**
 * 32 MiB, the same as the artefact default. A response the nexus would refuse to write
 * to a file is not one it should hold in memory to return either.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const ConnectorsConfigSchema = z
  .object({
    /** Idle timeout (seconds) before a cached upstream HTTP session is reaped. */
    httpReuseIdleTimeoutSeconds: z.number().int().min(1).max(86400).default(300),
    /** Interval (seconds) between recovery probes for failed sources. 0 = disabled. */
    recoveryIntervalSeconds: z.number().int().min(0).max(86400).default(30),
    /** An upstream response larger than this is abandoned rather than buffered. */
    maxResponseBytes: z.number().int().min(65_536).max(1_073_741_824).default(DEFAULT_MAX_RESPONSE_BYTES),
  })
  .strict();

const SemanticSearchConfigSchema = z
  .object({
    provider: z.enum(["built-in", "ollama", "openai-compatible"]),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().optional(),
    batchSize: z.number().int().min(1).max(256).default(32),
    modelCachePath: z.string().optional(),
    // Calibrated for all-MiniLM-L6-v2: the right tool scored 0.35-0.83 over a probe set,
    // queries nothing should match topped out at 0.15. 0.25 leaves room below the
    // weakest correct hit without letting those in. Other models use other scales.
    minSimilarity: z.number().min(0).max(1).default(0.25),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.provider === "ollama" && !s.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "baseUrl is required for ollama embedding provider",
        path: ["baseUrl"],
      });
    }
    if (s.provider === "openai-compatible") {
      if (!s.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "baseUrl is required for openai-compatible embedding provider",
          path: ["baseUrl"],
        });
      }
      if (!s.apiKeyEnv) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "apiKeyEnv is required for openai-compatible embedding provider",
          path: ["apiKeyEnv"],
        });
      }
    }
  });

const SearchConfigSchema = z
  .object({
    type: z.enum(["lexical", "semantic", "hybrid"]).default("lexical"),
    maxResults: z.number().int().min(1).max(100).default(20),
    semantic: SemanticSearchConfigSchema.optional(),
  })
  .strict();

/**
 * Artefact writing. Omitting this block entirely disables the feature — `call_tool`
 * then does not advertise an `artefacts` argument at all, so it costs nothing in the
 * agent's context on deployments that have nowhere to write.
 */
const ArtefactsConfigSchema = z
  .object({
    root: z.string().min(1),
    retentionDays: z.number().int().min(0).max(3650).default(14),
    runIdleMinutes: z.number().int().min(1).max(10_080).default(180),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(1_073_741_824)
      .default(32 * 1024 * 1024),
  })
  .strict();

const NexusConfigSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(8050),
    auth: AuthConfigSchema.default({}),
    connectors: ConnectorsConfigSchema.default({}),
    search: SearchConfigSchema.default({}),
    sources: z.array(SourceConfigSchema).min(1),
    artefacts: ArtefactsConfigSchema.optional(),
  })
  .strict();

/**
 * Source keys that were removed rather than never existing, with what replaced them.
 * Strict parsing would refuse them anyway; this says why, so the fix is not a guess.
 */
const RETIRED_SOURCE_KEYS: Record<string, string> = {
  type: "'type' was removed and is read by nothing - delete the line",
  projections: "'projections' was removed - pass 'select' on call_tool to trim a response, or 'artefacts' to keep it out of context",
};

/** The environment variable prefix for per-client tokens: MCP_NEXUS_TOKEN_LYRA is client `lyra`. */
const CLIENT_TOKEN_PREFIX = "MCP_NEXUS_TOKEN_";

/** The client name the shared MCP_NEXUS_AUTH_TOKEN authenticates as. */
export const DEFAULT_CLIENT = "default";

// ─── Loader ──────────────────────────────────────────────────────────────────

const CONFIG_PATHS = ["./mcp-nexus.yaml", "./mcp-nexus.yml", "./config/mcp-nexus.yaml"];

function resolveConfigPath(userPath?: string): string {
  if (userPath) {
    if (existsSync(userPath)) return userPath;
    throw new Error(`Config file not found: ${userPath}`);
  }
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error("No config file found. Create mcp-nexus.yaml or pass --config <path>");
}

/** Retired keys on any source, one message per occurrence. */
function retiredKeys(parsed: Record<string, unknown>): string[] {
  const sources: unknown[] = Array.isArray(parsed.sources) ? parsed.sources : [];
  return sources.flatMap((source, i) =>
    source && typeof source === "object"
      ? Object.keys(source)
          .filter((key) => key in RETIRED_SOURCE_KEYS)
          .map((key) => `  [sources.${i}.${key}] ${RETIRED_SOURCE_KEYS[key]}`)
      : [],
  );
}

/**
 * Per-client tokens from the environment, keyed by the lowercased client name.
 *
 * Two clients sharing a token could not be told apart, so the call log and every
 * policy decision would name whichever was found first — refused at startup instead.
 */
export function readClientTokens(env: NodeJS.ProcessEnv, sharedToken: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const owners = new Map<string, string>(sharedToken ? [[sharedToken, DEFAULT_CLIENT]] : []);

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(CLIENT_TOKEN_PREFIX) || value === undefined) continue;
    const name = key.slice(CLIENT_TOKEN_PREFIX.length).toLowerCase();
    if (!CLIENT_NAME.test(name)) throw new Error(`${key}: client name '${name}' must match ${CLIENT_NAME}`);
    if (name === DEFAULT_CLIENT) {
      throw new Error(`${key}: '${DEFAULT_CLIENT}' is the client MCP_NEXUS_AUTH_TOKEN authenticates as - use that variable`);
    }
    if (!value) throw new Error(`${key} is set but empty`);
    const owner = owners.get(value);
    if (owner) throw new Error(`${key} has the same token as client '${owner}' - each client needs its own`);
    owners.set(value, name);
    tokens[name] = value;
  }
  return tokens;
}

/**
 * Parse and check an already-loaded config document. Split from loadConfig so a test
 * can exercise validation without a file on disk.
 */
export function parseConfig(parsed: unknown, env: NodeJS.ProcessEnv = process.env): NexusConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid YAML: the document is not a mapping");
  }
  const document = parsed as Record<string, unknown>;

  const retired = retiredKeys(document);
  if (retired.length > 0) {
    throw new Error(`Config validation failed:\n${retired.join("\n")}`);
  }

  // Apply env var override for auth token
  const envToken = env["MCP_NEXUS_AUTH_TOKEN"];
  if (envToken) {
    // Ensure auth object exists even if YAML omitted it
    if (!document.auth || typeof document.auth !== "object") {
      document.auth = {};
    }
    (document.auth as Record<string, unknown>).token = envToken;
  }

  const result = NexusConfigSchema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  [${i.path.join(".")}] ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const clientTokens = readClientTokens(env, result.data.auth.token);
  const config: NexusConfig = { ...result.data, auth: { ...result.data.auth, clientTokens } };

  if (config.auth.enabled && !config.auth.token && Object.keys(clientTokens).length === 0) {
    throw new Error("Auth is enabled but no token is set. Set MCP_NEXUS_AUTH_TOKEN, or one MCP_NEXUS_TOKEN_<NAME> per client.");
  }

  // A bad pattern fails here rather than on the first call that reaches it.
  for (const [name, policy] of Object.entries(config.auth.clients)) {
    try {
      compileFilterPatterns([...(policy.allow ?? []), ...(policy.deny ?? []), ...(policy.confirm ?? [])]);
    } catch (err) {
      throw new Error(`auth.clients.${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const known = name === DEFAULT_CLIENT ? Boolean(config.auth.token) : name in clientTokens;
    if (config.auth.enabled && !known) {
      logger.warn(`auth.clients.${name} has a policy but no token, so no caller can authenticate as it`);
    }
  }

  return config;
}

export function loadConfig(userPath?: string): NexusConfig {
  const path = resolveConfigPath(userPath);
  logger.info(`Loading config from ${path}`);

  const config = parseConfig(parse(readFileSync(path, "utf-8")));

  const clients = [config.auth.token ? DEFAULT_CLIENT : undefined, ...Object.keys(config.auth.clientTokens)].filter(Boolean);
  logger.info(
    `Loaded ${config.sources.length} source(s), auth=${config.auth.enabled}` +
      (config.auth.enabled ? ` (clients: ${clients.join(", ")})` : "") +
      `, artefacts=${config.artefacts ? config.artefacts.root : "off"}`,
  );
  return config;
}
