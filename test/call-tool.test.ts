/**
 * call_tool end to end: a real NexusServer on a free port, a real MCP client, and a
 * stub stdio upstream (stub-upstream.mjs). These cover what only shows with every
 * layer present — argument checks before the call, `select` after it, policy per
 * client, confirmation, the response cap, the call log and the shutdown drain.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseConfig } from "../src/config.js";
import { buildIndex } from "../src/indexer.js";
import { NexusServer } from "../src/nexus-server.js";
import { SearchEngine } from "../src/search/index.js";
import { configureResponseLimit } from "../src/sources/limits.js";
import { killAll } from "../src/sources/stdio-source.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(here, "stub-upstream.mjs");

const TOKENS = {
  MCP_NEXUS_AUTH_TOKEN: "shared-token",
  MCP_NEXUS_TOKEN_LIMITED: "limited-token",
  MCP_NEXUS_TOKEN_CAREFUL: "careful-token",
};

function stubSource(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, description: "stub", transport: "stdio", command: process.execPath, args: [STUB], ...extra };
}

interface Running {
  server: NexusServer;
  url: string;
}

async function startNexus(document: Record<string, unknown>): Promise<Running> {
  const config = parseConfig(document, TOKENS);
  config.port = 0; // any free port; the schema itself insists on 1024+
  const index = await buildIndex(config.sources);
  const server = new NexusServer(config, index, new SearchEngine(config.search, index));
  server.resolvePreloadedTools();
  const port = await server.start();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function callTool(client: Client, args: Record<string, unknown>): Promise<{ result: CallToolResult; text: string }> {
  const result = (await client.callTool({ name: "call_tool", arguments: args })) as CallToolResult;
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  return { result, text };
}

/** Lines the call log wrote while `fn` ran, parsed. */
async function callLog(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[calls]")) lines.push(line);
    else original(...args);
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}

describe("call_tool", () => {
  let nexus: Running;
  let shared: Client;

  before(async () => {
    nexus = await startNexus({
      auth: {
        enabled: true,
        clients: {
          limited: { deny: ["stub__delete_*"] },
          careful: { confirmDestructive: true, confirm: ["stub__get_orders"] },
        },
      },
      sources: [stubSource("stub"), stubSource("open", { allowUnknownArguments: true })],
    });
    shared = await connect(nexus.url, "shared-token");
  });

  after(async () => {
    await shared.close();
    await nexus.server.shutdown();
    killAll();
  });

  test("an argument the tool does not declare is refused, with the likely intended one", async () => {
    const { result, text } = await callTool(shared, { toolName: "stub__get_tasks", parameters: { filtr: "today" } });
    assert.equal(result.isError, true);
    assert.match(text, /unknown argument 'filtr' - did you mean 'filter'\?/);
    assert.match(text, /"inputSchema"/);
  });

  test("a source with allowUnknownArguments passes them through", async () => {
    const { result, text } = await callTool(shared, { toolName: "open__get_tasks", parameters: { filtr: "today" } });
    assert.equal(result.isError, undefined);
    assert.match(text, /"filtr":"today"/);
  });

  test("select on a text response returns the text with a note, not an error", async () => {
    const { result, text } = await callTool(shared, { toolName: "stub__get_tasks", parameters: { filter: "today" }, select: ["tasks"] });
    assert.equal(result.isError, undefined);
    assert.match(text, /2 tasks, arguments received: \{"filter":"today"\}/);
    assert.match(text, /'select' was ignored/);
  });

  test("select on a JSON response trims it, and an unmatched path is an error", async () => {
    const trimmed = await callTool(shared, { toolName: "stub__get_orders", parameters: {}, select: ["orders[*].id"] });
    assert.equal(trimmed.result.isError, undefined);
    assert.deepEqual(JSON.parse(trimmed.text), { orders: [{ id: 1 }, { id: 2 }] });

    const typo = await callTool(shared, { toolName: "stub__get_orders", parameters: {}, select: ["orders[*].buyr"] });
    assert.equal(typo.result.isError, true);
    assert.match(typo.text, /select paths matched nothing/);
  });

  test("a denied tool is refused in call_tool and absent from browse_tools", async () => {
    const limited = await connect(nexus.url, "limited-token");
    try {
      const { result, text } = await callTool(limited, { toolName: "stub__delete_event", parameters: { id: "e1" } });
      assert.equal(result.isError, true);
      assert.match(text, /not available to this client \('limited'\)/);

      const browse = (await limited.callTool({ name: "browse_tools", arguments: { serviceId: "stub" } })) as CallToolResult;
      const tools = JSON.parse((browse.content[0] as { text: string }).text).tools as string[];
      assert.ok(tools.includes("stub__get_tasks"));
      assert.ok(!tools.includes("stub__delete_event"));
    } finally {
      await limited.close();
    }
  });

  test("the shared token keeps full access", async () => {
    const { result } = await callTool(shared, { toolName: "stub__delete_event", parameters: { id: "e1" } });
    assert.equal(result.isError, undefined);
  });

  test("a destructive tool needs a confirmation token, valid once and for that call only", async () => {
    const careful = await connect(nexus.url, "careful-token");
    try {
      const listed = await careful.listTools();
      const callTool_ = listed.tools.find((t) => t.name === "call_tool")!;
      assert.ok("confirm" in (callTool_.inputSchema.properties ?? {}), "confirm is advertised to a client that can need it");

      const first = await callTool(careful, { toolName: "stub__delete_event", parameters: { id: "e1" } });
      assert.equal(first.result.isError, true);
      const { confirm } = JSON.parse(first.text) as { confirm: string };
      assert.ok(confirm);

      const otherCall = await callTool(careful, { toolName: "stub__delete_event", parameters: { id: "e2" }, confirm });
      assert.equal(otherCall.result.isError, true, "a token for e1 does not delete e2");
      assert.match(otherCall.text, /issued for a different call/);

      const confirmed = await callTool(careful, { toolName: "stub__delete_event", parameters: { id: "e1" }, confirm });
      assert.equal(confirmed.result.isError, undefined);
      assert.deepEqual(JSON.parse(confirmed.text), { deleted: "e1" });

      const replay = await callTool(careful, { toolName: "stub__delete_event", parameters: { id: "e1" }, confirm });
      assert.equal(replay.result.isError, true, "a token is spent on use");

      const listedTool = await callTool(careful, { toolName: "stub__get_orders", parameters: {} });
      assert.match(listedTool.text, /policy lists stub__get_orders/);
    } finally {
      await careful.close();
    }
  });

  test("confirm is not advertised to a client whose policy never asks for it", async () => {
    const listed = await shared.listTools();
    const callTool_ = listed.tools.find((t) => t.name === "call_tool")!;
    assert.ok(!("confirm" in (callTool_.inputSchema.properties ?? {})));
  });

  test("the call log names the client and the argument names, never the values", async () => {
    const entries = await callLog(async () => {
      await callTool(shared, { toolName: "stub__get_tasks", parameters: { filter: "secret-filter-value", limit: 3 } });
      await callTool(shared, { toolName: "stub__get_tasks", parameters: { nope: 1 } });
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].client, "default");
    assert.equal(entries[0].tool, "stub__get_tasks");
    assert.equal(entries[0].outcome, "ok");
    assert.deepEqual(entries[0].args, ["filter", "limit"]);
    assert.equal(typeof entries[0].ms, "number");
    assert.equal(entries[1].outcome, "invalid_arguments");
    assert.ok(!JSON.stringify(entries).includes("secret-filter-value"));
  });

  test("a session cannot be used with another client's token", async () => {
    const init = await fetch(nexus.url, {
      method: "POST",
      headers: { Authorization: "Bearer limited-token", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const hijack = await fetch(nexus.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer shared-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(hijack.status, 403);

    const wrongToken = await fetch(nexus.url, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
    assert.equal(wrongToken.status, 401);
  });

  test("an upstream response over the cap is abandoned, and the next call still works", async () => {
    configureResponseLimit(70_000);
    try {
      const { result, text } = await callTool(shared, { toolName: "stub__big", parameters: { bytes: 200_000 } });
      assert.equal(result.isError, true);
      assert.match(text, /exceeded 70000 bytes/);

      const next = await callTool(shared, { toolName: "stub__big", parameters: { bytes: 10 } });
      assert.equal(next.result.isError, undefined);
      assert.equal(next.text, "x".repeat(10));
    } finally {
      configureResponseLimit(32 * 1024 * 1024);
    }
  });

  test("/health reports the search strategy", async () => {
    const health = (await (await fetch(new URL("health", nexus.url))).json()) as { status: string; search: { configured: string; semantic: string } };
    assert.equal(health.status, "ok");
    assert.deepEqual(health.search, { configured: "lexical", semantic: "not-configured" });
  });
});

describe("shutdown", () => {
  test("waits for a call in flight before closing", async () => {
    const nexus = await startNexus({ auth: { enabled: false }, sources: [stubSource("stub")] });
    const client = await connect(nexus.url, "unused");
    try {
      const pending = callTool(client, { toolName: "stub__slow", parameters: { ms: 400 } });
      await new Promise((r) => setTimeout(r, 100));
      const stopped = nexus.server.shutdown();
      const { result, text } = await pending;
      await stopped;
      assert.equal(result.isError, undefined);
      assert.equal(text, "done");

      const late = await fetch(nexus.url, { method: "POST", body: "{}" }).catch(() => undefined);
      assert.ok(!late || late.status === 503, "nothing new is taken once shutdown has begun");
    } finally {
      await client.close().catch(() => {});
      killAll();
    }
  });
});
