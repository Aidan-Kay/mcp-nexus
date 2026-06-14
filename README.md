# MCP Nexus

> Browse-first MCP middleware — an LLM-friendly nexus for discovering and invoking MCP tools across multiple services.

AI agents use this as a single MCP endpoint to **browse**, **inspect**, and **call** tools from many upstream MCP servers — without flooding their context with every tool schema upfront.

## How It Works

Instead of connecting every MCP server directly (and loading all their tool schemas at session start), agents connect to **one** nexus server and discover tools on demand:

```
browse_services              → [{id: "todoist", name: "Todoist"}, {id: "outlook", ...}]
browse_tools("todoist")      → ["todoist__get-task", "todoist__create-task", ...]
get_schemas(["todoist__get-task"])  → [full input schema]
call_tool("todoist__get-task", {id: "123"}) → result
```

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
| `sources[].id`                           | Unique identifier for the source (used in namespaced tool names)                                                   |
| `sources[].transport`                    | `"http"` for Streamable HTTP, `"stdio"` for subprocess                                                             |
| `sources[].url`                          | Upstream MCP server URL (required for HTTP transport)                                                              |
| `sources[].command`                      | Executable to spawn (required for stdio transport)                                                                 |
| `sources[].filter`                       | Optional glob patterns to curate which tools are indexed                                                           |
| `sources[].preloadedTools`               | Optional array of non-prefixed tool names to surface directly in `tools/list` (e.g. `[\"search-emails\"]`)         |

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
  indexer.ts            Startup index — fetches tools/list from all sources
  nexus-server.ts      MCP server — tool definitions and request handling
  sources/
    http-source.ts      HTTP transport client (Streamable HTTP)
    stdio-source.ts     Stdio transport client (subprocess, JSON-RPC)
```

## Scripts

| Command                | Description                         |
| ---------------------- | ----------------------------------- |
| `npm run dev`          | Run with hot reload via `tsx watch` |
| `npm start`            | Run without watch                   |
| `npm run build`        | Compile TypeScript to `dist/`       |
| `npm run docker:build` | Build Docker image                  |
| `npm run docker:run`   | Run Docker container                |
