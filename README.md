# MCP Nexus

> Browse-first MCP middleware — an LLM-friendly nexus for discovering and invoking MCP tools across multiple services.

AI agents use this as a single MCP endpoint to **browse**, **inspect**, and **call** tools from many upstream MCP servers — without flooding their context with every tool schema upfront.

## How It Works

Instead of connecting every MCP server directly (and loading all their tool schemas at session start), agents connect to **one** nexus server and discover tools on demand:

```
browse_services              → [{id: "todoist", name: "Todoist"}, {id: "outlook", ...}]
browse_tools("todoist")      → ["todoist__get-task", "todoist__create-task", ...]
search_tools("send email")   → [{name: "outlook__search-emails", serviceId: "outlook", inputSchema: {...}}, ...]
get_schemas(["todoist__get-task"])  → [full input schema]   (for browsed tools, or a hit with inputSchemaTrimmed)
call_tool("todoist__get-task", {id: "123"}) → result
```

Agents can either **browse** (list services → list tools) or **search** (find tools by keyword or semantic similarity across all services at once).

The service roster itself costs no tool call at all: the nexus renders it into the `instructions` field of the MCP `initialize` response, which clients inject into the model's system prompt. An agent knows which services exist, what each covers, and how many tools each carries before it makes a single request — `browse_services` remains for clients that ignore `instructions`, and for checking live availability.

Instructions are sent once per session and cannot be revised afterwards, so only durable facts go into them. Availability shifts as the recovery poller re-probes failed sources, which is why status stays in `browse_services` and `index`.

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

| Field                                    | Description                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `port`                                   | HTTP port for the MCP endpoint (default: 8050)                                                                      |
| `auth.enabled`                           | Require `Authorization: Bearer <token>` header                                                                      |
| `auth.token`                             | Static bearer token (override via `MCP_NEXUS_AUTH_TOKEN` env var)                                                   |
| `auth.allowedOrigins`                    | Optional list of origins allowed via CORS when auth is enabled. If omitted, the request `Origin` is reflected back  |
| `connectors.httpReuseIdleTimeoutSeconds` | Idle timeout before a cached upstream HTTP session is reaped (default: 300)                                         |
| `connectors.recoveryIntervalSeconds`     | Interval (seconds) for background recovery probes of failed sources. 0 = disabled (default: 30)                     |
| `search.type`                            | Search strategy: `"lexical"` (keyword matching, default) or `"semantic"` (embedding-based similarity)               |
| `search.maxResults`                      | Max results returned by `search_tools` (default: 20)                                                                |
| `search.semantic.provider`               | Embedding provider: `"built-in"` (local model), `"ollama"`, or `"openai-compatible"` (required if type is semantic) |
| `search.semantic.model`                  | Model name (provider-specific; defaults vary by provider)                                                           |
| `search.semantic.baseUrl`                | Base URL for `ollama` or `openai-compatible` providers (required for those providers)                               |
| `search.semantic.apiKeyEnv`              | Name of env var containing the API key (required for `openai-compatible`)                                           |
| `search.semantic.batchSize`              | Batch size for embedding generation at index time (default: 32)                                                     |
| `search.semantic.modelCachePath`         | Where to cache the downloaded model (`built-in` provider only)                                                      |
| `search.semantic.minSimilarity`          | Cosine similarity a tool must reach to be returned at all (default: 0.25, calibrated for all-MiniLM-L6-v2)           |
| `sources[].id`                           | Unique identifier for the source (used in namespaced tool names)                                                    |
| `sources[].transport`                    | `"http"` for Streamable HTTP, `"stdio"` for subprocess                                                              |
| `sources[].url`                          | Upstream MCP server URL (required for HTTP transport)                                                               |
| `sources[].command`                      | Executable to spawn (required for stdio transport)                                                                  |
| `sources[].filter`                       | Optional glob patterns to curate which tools are indexed                                                            |
| `sources[].preloadedTools`               | Optional array of non-prefixed tool names to surface directly in `tools/list` (e.g. `[\"search-emails\"]`)          |
| `sources[].projections`                  | Optional default response projections, keyed by non-prefixed tool name (see [Response Shaping](#response-shaping))   |
| `artefacts.root`                         | Directory artefacts are written under. Omit the whole `artefacts` block to disable the feature (see [Artefacts](#artefacts)) |
| `artefacts.retentionDays`                | Delete run directories older than this, at startup and daily (default: 14; 0 = never)                               |
| `artefacts.runIdleMinutes`               | How long a label keeps resolving to the same run directory (default: 180)                                           |
| `artefacts.maxBytes`                     | Refuse to write a single artefact larger than this (default: 33554432)                                              |

## Search

The `search_tools` tool lets agents find tools by query instead of browsing every service. Every hit carries its description, `responseShape` (once the tool has been called) and a **compact** input schema: each top-level argument is kept whole when it is simple — scalars, enums, arrays and maps of scalars — and a structured one (a nested object, an array of objects, a `$ref`) is cut to its type and description and named in `inputSchemaTrimmed`. A hit without `inputSchemaTrimmed` has its complete schema and can go straight to `call_tool`; one with it needs `get_schemas` first. This keeps a search over Graph-backed tools, whose schemas embed whole message and event entities, from costing thousands of tokens.

`totalMatches` counts real matches rather than tools scanned. Under lexical search that is every tool matching a query word. Under semantic search every tool has *some* similarity, so only those at or above `search.semantic.minSimilarity` are counted or returned: a search may come back with fewer than `maxResults` hits, and a query nothing resembles comes back empty rather than padded with weak guesses.

Two strategies are available, configured at startup via `search.type`:

### Lexical (default)

Keyword matching against tool names and descriptions. Fast, no dependencies. Best for queries like `"send email"` or `"ebay orders"` — concise terms that appear in the tool metadata.

Tool names and descriptions are split into words (on punctuation and camelCase), and a query word matches any word it is a prefix of — `email` finds `emails`, but `an` does not match `manage`. Common filler words (`a`, `an`, `the`, `to`, `my`, …) are dropped from the query unless it contains nothing else.

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

| Provider            | Description                                               | Config                                                  |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `built-in`          | Local model via Transformers.js (all-MiniLM-L6-v2, 384d)  | No external dependencies. Downloads model on first run. |
| `ollama`            | Local Ollama instance (nomic-embed-text, 768d)            | Requires `baseUrl` (e.g. `http://localhost:11434`)      |
| `openai-compatible` | Any OpenAI-compatible API (text-embedding-3-small, 1536d) | Requires `baseUrl`, `apiKeyEnv`, and `model`            |

If the semantic provider fails at query time (e.g. Ollama is down), the search engine **falls back to lexical** automatically. The response includes `strategy` and `fellBackToLexical` fields so the agent can tell what happened.

## Docker

CI builds the image from each commit on `main` and publishes it as
`ghcr.io/aidan-kay/mcp-nexus`, tagged `latest` and with the commit SHA. A local build
copies the working tree, so it builds what is on disk, uncommitted changes included.

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
| `search_tools`    | Search for tools by keyword (lexical) or natural language (semantic); every hit carries a compact schema |
| `get_schemas`     | Get input schemas and inferred response shapes for one or more tools   |
| `call_tool`       | Call a tool on an upstream service, optionally trimming the response or writing it to a file. Arguments are checked against the tool's input schema first; a mismatch is refused with the problems and the schema |
| `index`           | Diagnostic — shows index summary, source availability, and error info  |

Additionally, any tools listed under `preloadedTools` on a source will appear directly in the `tools/list` response alongside the built-in nexus tools — no browsing needed.

## Response Shaping

Upstream tools routinely return far more than an agent needs — every field of every
record, often pretty-printed. That width lands directly in the agent's context, so
the nexus trims it on the way through.

**Always applied.** Responses are forwarded as the upstream service's own content
blocks, with each JSON block re-serialised compactly. This is lossless — nothing is
dropped, and blocks that aren't JSON (prose errors, images, embedded resources) pass
through untouched. On live eBay responses this alone removes 38–48% of the bytes.

**Projections.** To trim fields as well, give `call_tool` a `select` array of dotted
paths. `[*]` maps over an array, and the original nesting is preserved:

```jsonc
{
  "toolName": "ebay__ebay_get_inventory_items",
  "parameters": { "limit": 25 },
  "select": ["total", "inventoryItems[*].sku", "inventoryItems[*].product.title"]
}
```

A path matching nothing is returned as an **error**, not as absent data, so a typo
can't be mistaken for a field the service doesn't return. The error carries the
tool's response shape so the caller can correct itself.

For tools that are *always* too wide, set a default under `sources[].projections`
instead — keyed by the tool's own name, applied to every call, and overridden by an
explicit `select`. A configured projection whose paths have drifted out of date warns
and skips them rather than failing, since the caller didn't write it.

**Discovering paths.** Most services declare no `outputSchema`, so `get_schemas`
reports a `responseShape` instead: the leaf paths and types of what the tool last
returned, learned from calls as they pass through. Its size is fixed regardless of
how many records came back. If a tool hasn't been called yet, make one small call
first (most take a `limit` or `pageSize`) and the shape will be recorded.

## Artefacts

Projections trim a response; artefacts remove it from the conversation altogether.
When a result is only ever going to be aggregated by code — a full orders feed, a
whole catalogue — passing an `artefacts` label writes it to a file and returns a
receipt instead:

```jsonc
{
  "toolName": "ebay__ebay_get_orders",
  "parameters": { "limit": 25, "offset": 50 },
  "artefacts": "ebay-weekly-review"
}
```

```jsonc
{
  "artefact": {
    "run": "20260824-161204-ebay-weekly-review",
    "dir": "/data/artefacts/20260824-161204-ebay-weekly-review",
    "path": "/data/artefacts/20260824-161204-ebay-weekly-review/ebay_get_orders-a3f1c92b.json",
    "bytes": 18206,
    "records": 25,
    "recordPath": "orders",
    "shape": ["total: number", "orders[*].lineItems[*].legacyItemId: string", "…"]
  }
}
```

The agent then runs code against `dir`. Nothing about the payload enters its context.

This requires a code executor that can see the same absolute path — mount one
volume into both containers at the same location. Read-only on the executor's side
is the cleanest arrangement: artefacts are the nexus's output and its input.

**`artefacts` is a label, not a path.** The caller names the task; the nexus builds
the directory name from a timestamp and the label reduced to `[a-z0-9-]`, and
resolves it strictly under `root`. Every call sharing a label lands in one
directory until it has been idle for `runIdleMinutes`, so a multi-call pull needs no
coordination — and last week's run can never be read as this week's.

**Filenames are derived from the tool and a digest of its arguments**, so a retried
page overwrites itself instead of leaving a duplicate for the aggregation to
double-count.

**`records` is the count of the largest top-level array**, reported per file so a
caller can check that pages sum to the expected total without opening anything. A
page past the end of a feed reports `0` rather than going missing.

**Projections still apply.** The context argument for trimming disappears, but the
reason to keep buyer addresses out of a response is not that they are expensive.
`select` still overrides a configured projection, and `shape` describes what is
actually in the file — not the wider upstream response, which `get_schemas` still
reports in full.

**Errors are never written to a file.** Transport failures, upstream tool errors and
unmatched `select` paths all come back inline, as they do without a label. If the
*write* fails, the call returns an error naming the path and errno — the payload is
deliberately not returned instead, since dumping a whole feed into the context is
the failure the caller was avoiding.

Preloaded tools take no `artefacts` argument (or `select`), since they are dispatched
with the upstream schema verbatim. A tool wide enough to want either should be
reached through `call_tool`.

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
  artefacts.ts          Run directories, artefact writing, retention
  recovery.ts           Background recovery probes for failed sources
  validation.ts         call_tool argument checking against the upstream input schema
  nexus-server.ts       MCP server — tool definitions and request handling
  sources/
    http-source.ts      HTTP transport client (Streamable HTTP)
    stdio-source.ts     Stdio transport client (subprocess, JSON-RPC)
  search/
    index.ts            SearchEngine — strategy dispatch + fallback
    types.ts            Search config, result, and provider interfaces
    lexical-search.ts   Keyword matching (word-prefix scoring, stopwords dropped)
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
