# MCP Nexus

> Browse-first MCP middleware — an LLM-friendly nexus for discovering and invoking MCP tools across multiple services.

AI agents use this as a single MCP endpoint to **browse**, **inspect**, and **call** tools from many upstream MCP servers — without flooding their context with every tool schema upfront.

## How It Works

Instead of connecting every MCP server directly (and loading all their tool schemas at session start), agents connect to **one** nexus server and discover tools on demand:

```
browse_services              → [{id: "todoist", name: "Todoist"}, {id: "outlook", ...}]
browse_tools("todoist")      → ["todoist__get-task", "todoist__create-task", ...]
search_tools("send email")   → [{name: "outlook__search-emails", serviceId: "outlook"}, ...]
get_schemas(["todoist__get-task"])  → [full input schema]
call_tool("todoist__get-task", {id: "123"}) → result
```

Agents can either **browse** (list services → list tools) or **search** (find tools by keyword or semantic similarity across all services at once).

## Quick Start

### Prerequisites

- Node.js 22+

### Install & Run

```bash
# Install dependencies
npm install

# Copy a config (or create your own)
cp mcp-nexus.example.yaml mcp-nexus.yaml

# Start in dev mode (with hot reload)
npm run dev

# Or with a custom config path and verbose logging
npx tsx src/index.ts --config ./mcp-nexus.example.yaml --verbose
```

### Verify It's Running

```bash
# Health check
curl http://localhost:8050/health
```

## Configuration

Create a `mcp-nexus.yaml` file:

```yaml
port: 8050

auth:
  enabled: false # Set to true and provide a token in production
  token: ""
  allowedOrigins: # Optional — restrict CORS to these origins when auth is on
    - https://openwebui.local

connectors:
  httpReuseIdleTimeoutSeconds: 300 # Reap idle upstream HTTP sessions after N seconds
  recoveryIntervalSeconds: 30 # Probe failed sources every N seconds (0 = disabled)

search:
  type: lexical # "lexical" (keyword matching) or "semantic" (embedding-based)
  maxResults: 20
  # semantic: # Uncomment to enable semantic search
  #   provider: built-in # "built-in" (local), "ollama", or "openai-compatible"
  #   model: Xenova/all-MiniLM-L6-v2
  #   batchSize: 32
  #   # For ollama: provider: ollama, baseUrl: http://ollama:11434, model: nomic-embed-text
  #   # For openai-compatible: provider: openai-compatible, baseUrl: https://api.openai.com, model: text-embedding-3-small, apiKeyEnv: OPENAI_API_KEY

sources:
  - id: todoist
    name: Todoist
    description: Task and project management
    transport: http
    url: http://todoist-mcp:8081/mcp
    filter: ["*"] # Glob patterns — only index matching tools

  - id: outlook
    name: Outlook
    description: Email and calendar
    transport: stdio
    command: npx
    args: ["-y", "@softeria/ms-365-mcp-server"]
    env:
      API_KEY: "your-key"
    preloadedTools:
      - search-emails
      - list-folders
```

### Config Reference

| Field                                    | Description                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `port`                                   | HTTP port for the MCP endpoint (default: 8050)                                                                     |
| `auth.enabled`                           | Require `Authorization: Bearer <token>` header                                                                     |
| `auth.token`                             | Static bearer token (override via `MCP_NEXUS_AUTH_TOKEN` env var)                                                  |
| `auth.allowedOrigins`                    | Optional list of origins allowed via CORS when auth is enabled. If omitted, the request `Origin` is reflected back |
| `connectors.httpReuseIdleTimeoutSeconds` | Idle timeout before a cached upstream HTTP session is reaped (default: 300)                                        |
| `connectors.recoveryIntervalSeconds`     | Interval (seconds) for background recovery probes of failed sources. 0 = disabled (default: 30)                    |
| `search.type`                            | Search strategy: `"lexical"` (keyword matching, default) or `"semantic"` (embedding-based similarity)              |
| `search.maxResults`                      | Max results returned by `search_tools` (default: 20)                                                              |
| `search.semantic.provider`               | Embedding provider: `"built-in"` (local model), `"ollama"`, or `"openai-compatible"` (required if type is semantic) |
| `search.semantic.model`                  | Model name (provider-specific; defaults vary by provider)                                                         |
| `search.semantic.baseUrl`                | Base URL for `ollama` or `openai-compatible` providers (required for those providers)                              |
| `search.semantic.apiKeyEnv`              | Name of env var containing the API key (required for `openai-compatible`)                                          |
| `search.semantic.batchSize`              | Batch size for embedding generation at index time (default: 32)                                                   |
| `search.semantic.modelCachePath`         | Where to cache the downloaded model (`built-in` provider only)                                                    |
| `sources[].id`                           | Unique identifier for the source (used in namespaced tool names)                                                   |
| `sources[].transport`                    | `"http"` for Streamable HTTP, `"stdio"` for subprocess                                                             |
| `sources[].url`                          | Upstream MCP server URL (required for HTTP transport)                                                              |
| `sources[].command`                      | Executable to spawn (required for stdio transport)                                                                 |
| `sources[].filter`                       | Optional glob patterns to curate which tools are indexed                                                           |
| `sources[].preloadedTools`               | Optional array of non-prefixed tool names to surface directly in `tools/list` (e.g. `[\"search-emails\"]`)         |

## Search

The `search_tools` tool lets agents find tools by query instead of browsing every service. Two strategies are available, configured at startup via `search.type`:

### Lexical (default)

Keyword matching against tool names and descriptions. Fast, no dependencies. Best for queries like `"send email"` or `"ebay orders"` — concise terms that appear in the tool metadata.

```yaml
search:
  type: lexical
  maxResults: 20
```

### Semantic

Embedding-based similarity search. Understands natural-language intent like `"I want to send an email"` or `"find tools for managing my inbox"`. Requires an embedding provider.

```yaml
search:
  type: semantic
  maxResults: 20
  semantic:
    provider: built-in # local model, no external dependencies
    model: Xenova/all-MiniLM-L6-v2
    batchSize: 32
    modelCachePath: /app/data/model-cache
```

#### Embedding Providers

| Provider              | Description                                              | Config                                                                 |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `built-in`            | Local model via Transformers.js (all-MiniLM-L6-v2, 384d) | No external dependencies. Downloads model on first run.               |
| `ollama`              | Local Ollama instance (nomic-embed-text, 768d)           | Requires `baseUrl` (e.g. `http://localhost:11434`)                     |
| `openai-compatible`   | Any OpenAI-compatible API (text-embedding-3-small, 1536d) | Requires `baseUrl`, `apiKeyEnv`, and `model`                           |

If the semantic provider fails at query time (e.g. Ollama is down), the search engine **falls back to lexical** automatically. The response includes `strategy` and `fellBackToLexical` fields so the agent can tell what happened.

## Docker

```bash
# Build
npm run docker:build

# Run
docker run -d \
  --name mcp-nexus \
  -p 8050:8050 \
  -v ./mcp-nexus.yaml:/app/mcp-nexus.yaml \
  -e MCP_NEXUS_AUTH_TOKEN=your-token \
  mcp-nexus
```

Or use the provided Dockerfile directly:

```bash
docker build -t mcp-nexus .
```

## MCP Tools

The nexus exposes these tools to connected AI agents:

| Tool              | What it does                                                           |
| ----------------- | ---------------------------------------------------------------------- |
| `browse_services` | List all available upstream services with descriptions and tool counts |
| `browse_tools`    | List all tools for a specific service (namespaced names)               |
| `search_tools`    | Search for tools by keyword (lexical) or natural language (semantic)   |
| `get_schemas`     | Get full input schemas for one or more tools in bulk                   |
| `call_tool`       | Call a tool on an upstream service (passes through the result)         |
| `index`           | Diagnostic — shows index summary, source availability, and error info  |

Additionally, any tools listed under `preloadedTools` on a source will appear directly in the `tools/list` response alongside the built-in nexus tools — no browsing needed.

## Architecture

```
AI Agent ──Streamable HTTP──▶ mcp-nexus ──HTTP/stdio──▶ todoist, outlook, ...
                                  │
                              In-memory index
                              Session management
```

- **Transport**: MCP Streamable HTTP (2025-11-05)
- **Auth**: Optional bearer token, with optional CORS origin allowlist
- **Health**: `GET /health` endpoint for monitoring (Uptime Kuma, etc.)
- **HTTP connection reuse**: keep-alive sessions per source, reaped after an idle timeout

## Project Structure

```
src/
  index.ts              Entry point with CLI args
  config.ts             YAML loader with Zod validation
  types.ts              Shared types and interfaces
  logger.ts             Structured logger
  namespace.ts          Tool name namespacing (<sourceId>__<toolName>)
  glob-utils.ts         Glob pattern matching for tool filtering
  indexer.ts            Startup index — fetches tools/list from all sources
  recovery.ts           Background recovery probes for failed sources
  nexus-server.ts       MCP server — tool definitions and request handling
  sources/
    http-source.ts      HTTP transport client (Streamable HTTP)
    stdio-source.ts     Stdio transport client (subprocess, JSON-RPC)
  search/
    index.ts            SearchEngine — strategy dispatch + fallback
    types.ts            Search config, result, and provider interfaces
    lexical-search.ts   Keyword matching (token-based scoring)
    semantic-search.ts  Embedding similarity search
    providers/
      builtin.ts        Transformers.js (all-MiniLM-L6-v2, local)
      ollama.ts         Ollama embedding API (nomic-embed-text)
      openai.ts         OpenAI-compatible embedding API
```

## Scripts

| Command                | Description                         |
| ---------------------- | ----------------------------------- |
| `npm run dev`          | Run with hot reload via `tsx watch` |
| `npm start`            | Run without watch                   |
| `npm run build`        | Compile TypeScript to `dist/`       |
| `npm run docker:build` | Build Docker image                  |
| `npm run docker:run`   | Run Docker container                |
