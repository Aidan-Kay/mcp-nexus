/** YAML config loader with Zod validation */

import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
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
    requestTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
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

const AuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(""),
  /** When set, only these origins are echoed in CORS headers. Empty/unset = reflect any origin. */
  allowedOrigins: z.array(z.string()).optional(),
});

const ConnectorsConfigSchema = z.object({
  /** Idle timeout (seconds) before a cached upstream HTTP session is reaped. */
  httpReuseIdleTimeoutSeconds: z.number().int().min(1).max(86400).default(300),
  /** Interval (seconds) between recovery probes for failed sources. 0 = disabled. */
  recoveryIntervalSeconds: z.number().int().min(0).max(86400).default(30),
});

const SemanticSearchConfigSchema = z
  .object({
    provider: z.enum(["built-in", "ollama", "openai-compatible"]),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().optional(),
    batchSize: z.number().int().min(1).max(256).default(32),
    modelCachePath: z.string().optional(),
  })
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

const SearchConfigSchema = z.object({
  type: z.enum(["lexical", "semantic"]).default("lexical"),
  maxResults: z.number().int().min(1).max(100).default(20),
  semantic: SemanticSearchConfigSchema.optional(),
});

const NexusConfigSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8050),
  auth: AuthConfigSchema.default({ enabled: false, token: "" }),
  connectors: ConnectorsConfigSchema.default({
    httpReuseIdleTimeoutSeconds: 300,
    recoveryIntervalSeconds: 30,
  }),
  search: SearchConfigSchema.default({
    type: "lexical",
    maxResults: 20,
  }),
  sources: z.array(SourceConfigSchema).min(1),
});

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

export function loadConfig(userPath?: string): NexusConfig {
  const path = resolveConfigPath(userPath);
  logger.info(`Loading config from ${path}`);

  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid YAML in ${path}`);
  }

  // Apply env var override for auth token
  const envToken = process.env["MCP_NEXUS_AUTH_TOKEN"];
  if (envToken) {
    // Ensure auth object exists even if YAML omitted it
    if (!parsed.auth || typeof parsed.auth !== "object") {
      (parsed as Record<string, unknown>)["auth"] = {};
    }
    parsed.auth.token = envToken;
  }

  const result = NexusConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  [${i.path.join(".")}] ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const config = result.data;

  // Validate: if auth is enabled, token must not be empty
  if (config.auth.enabled && !config.auth.token) {
    throw new Error("Auth is enabled but token is empty. Set MCP_NEXUS_AUTH_TOKEN env var or provide a token in the config.");
  }

  logger.info(`Loaded ${config.sources.length} source(s), auth=${config.auth.enabled}`);
  return config;
}
