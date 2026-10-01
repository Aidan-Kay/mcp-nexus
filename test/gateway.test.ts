/**
 * The decisions behind call_tool, one module at a time: what the config accepts,
 * which client a token is, what a client may call, when a call needs confirming,
 * which arguments are refused, and how search ranks and reports itself.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { parseConfig, readClientTokens } from "../src/config.js";
import { ANONYMOUS_CLIENT, authenticate, ClientAccess, CONFIRMATION_TTL_MS, ConfirmationStore } from "../src/gateway.js";
import { SearchEngine } from "../src/search/index.js";
import { analyzeLexical } from "../src/search/lexical-search.js";
import { applySuggestions, suggestedInstead } from "../src/search/redirects.js";
import type { EmbeddingProvider } from "../src/search/types.js";
import type { AuthConfig, IndexedTool, NexusIndex } from "../src/types.js";
import { validateArguments } from "../src/validation.js";

const SOURCE = { id: "todoist", name: "Todoist", transport: "http", url: "http://todoist:8081/mcp" };

describe("config", () => {
  test("a retired key is refused with what replaced it", () => {
    assert.throws(() => parseConfig({ sources: [{ ...SOURCE, projections: { x: ["a"] } }] }, {}), /'projections' was removed - pass 'select'/);
    assert.throws(() => parseConfig({ sources: [{ ...SOURCE, type: "gateway" }] }, {}), /'type' was removed/);
  });

  test("any unknown key is refused rather than dropped", () => {
    assert.throws(() => parseConfig({ sources: [{ ...SOURCE, filters: ["*"] }] }, {}), /Unrecognized key\(s\) in object: 'filters'/);
    assert.throws(() => parseConfig({ sources: [SOURCE], search: { type: "hybrid", maxresults: 5 } }, {}), /maxresults/);
    assert.throws(() => parseConfig({ sources: [SOURCE], tokens: {} }, {}), /tokens/);
  });

  test("defaults fill in for omitted blocks", () => {
    const config = parseConfig({ sources: [SOURCE] }, {});
    assert.equal(config.connectors.maxResponseBytes, 32 * 1024 * 1024);
    assert.deepEqual(config.auth.clients, {});
    assert.equal(config.search.type, "lexical");
  });

  test("client tokens come from MCP_NEXUS_TOKEN_<NAME>, lowercased", () => {
    const config = parseConfig(
      { auth: { enabled: true, clients: { lyra: { deny: ["ebay__*"] } } }, sources: [SOURCE] },
      { MCP_NEXUS_TOKEN_LYRA: "t1", MCP_NEXUS_TOKEN_N8N: "t2" },
    );
    assert.deepEqual(config.auth.clientTokens, { lyra: "t1", n8n: "t2" });
    assert.equal(config.auth.token, "");
  });

  test("tokens that cannot identify a client are refused", () => {
    assert.throws(() => readClientTokens({ MCP_NEXUS_TOKEN_A: "same", MCP_NEXUS_TOKEN_B: "same" }, ""), /same token as client 'a'/);
    assert.throws(() => readClientTokens({ MCP_NEXUS_TOKEN_X: "shared" }, "shared"), /same token as client 'default'/);
    assert.throws(() => readClientTokens({ MCP_NEXUS_TOKEN_DEFAULT: "t" }, ""), /use that variable/);
    assert.throws(() => readClientTokens({ MCP_NEXUS_TOKEN_A: "" }, ""), /set but empty/);
  });

  test("auth on with no token at all is refused", () => {
    assert.throws(() => parseConfig({ auth: { enabled: true }, sources: [SOURCE] }, {}), /no token is set/);
    assert.doesNotThrow(() => parseConfig({ auth: { enabled: true }, sources: [SOURCE] }, { MCP_NEXUS_TOKEN_LYRA: "t" }));
  });

  test("a policy pattern that cannot compile fails at startup", () => {
    assert.throws(
      () => parseConfig({ auth: { clients: { lyra: { deny: ["*a*b*c*d*e*f*g*h*i*j*k*"] } } }, sources: [SOURCE] }, {}),
      /auth\.clients\.lyra: .*wildcards/,
    );
  });
});

describe("authenticate", () => {
  const auth: AuthConfig = { enabled: true, token: "shared", clientTokens: { lyra: "lyra-token" }, clients: {} };

  test("each token is its own client", () => {
    assert.equal(authenticate("Bearer shared", auth), "default");
    assert.equal(authenticate("Bearer lyra-token", auth), "lyra");
  });

  test("anything else is nobody", () => {
    assert.equal(authenticate("Bearer lyra-tokenx", auth), null);
    assert.equal(authenticate("lyra-token", auth), null);
    assert.equal(authenticate(undefined, auth), null);
  });

  test("with auth off every caller is anonymous", () => {
    assert.equal(authenticate(undefined, { ...auth, enabled: false }), ANONYMOUS_CLIENT);
  });
});

describe("client policy", () => {
  const tool = (annotations?: Tool["annotations"]): Tool => ({ name: "t", inputSchema: { type: "object" }, annotations });

  test("a client without a policy may call anything", () => {
    const access = new ClientAccess("n8n", undefined);
    assert.ok(access.permits("ebay__ebay_issue_refund"));
    assert.equal(access.confirms, false);
  });

  test("allow narrows, deny removes, and deny wins", () => {
    const access = new ClientAccess("lyra", { allow: ["todoist__*", "ms365__*"], deny: ["ms365__delete-*"], confirmDestructive: false });
    assert.ok(access.permits("todoist__todoist_task_get"));
    assert.ok(access.permits("ms365__send-mail"));
    assert.ok(!access.permits("ms365__delete-mail-message"));
    assert.ok(!access.permits("ebay__ebay_get_orders"));
  });

  test("only an explicit destructiveHint: true asks for confirmation", () => {
    const access = new ClientAccess("lyra", { confirmDestructive: true });
    assert.match(access.confirmationReason("ms365__delete-event", tool({ destructiveHint: true }))!, /marks .* as destructive/);
    assert.equal(access.confirmationReason("todoist__todoist_task_delete", tool()), undefined, "absent annotation is not read as destructive");
    assert.equal(access.confirmationReason("plex__x", tool({ destructiveHint: false })), undefined);
  });

  test("a confirm pattern covers tools the service never annotated", () => {
    const access = new ClientAccess("lyra", { confirm: ["ebay__ebay_issue_refund"], confirmDestructive: false });
    assert.ok(access.confirms);
    assert.match(access.confirmationReason("ebay__ebay_issue_refund", tool())!, /policy lists/);
    assert.equal(access.confirmationReason("ebay__ebay_get_orders", tool()), undefined);
  });
});

describe("confirmation tokens", () => {
  test("bound to client, tool and arguments, spent on use", () => {
    const store = new ConfirmationStore();
    const token = store.issue("lyra", "ms365__delete-event", { id: "e1", notify: true });
    assert.ok(!store.redeem(token, "n8n", "ms365__delete-event", { id: "e1", notify: true }), "another client");
    assert.ok(!store.redeem(token, "lyra", "ms365__delete-event", { id: "e2", notify: true }), "other arguments");
    assert.ok(store.redeem(token, "lyra", "ms365__delete-event", { notify: true, id: "e1" }), "key order does not matter");
    assert.ok(!store.redeem(token, "lyra", "ms365__delete-event", { id: "e1", notify: true }), "spent");
  });

  test("expire after the TTL", () => {
    let now = 1_000_000;
    const store = new ConfirmationStore(() => now);
    const token = store.issue("lyra", "t", {});
    now += CONFIRMATION_TTL_MS;
    assert.ok(!store.redeem(token, "lyra", "t", {}));
  });
});

describe("argument validation", () => {
  const schema = { type: "object", properties: { filter: { type: "string" }, due_before: { type: "string" }, limit: { type: "number" } } };

  test("an undeclared argument is refused even when the schema leaves additionalProperties unset", () => {
    assert.deepEqual(validateArguments("t", schema, { filtr: "today" }), ["parameters: unknown argument 'filtr' - did you mean 'filter'?"]);
    assert.deepEqual(validateArguments("t", schema, { due_date: "today" }), ["parameters: unknown argument 'due_date' - did you mean 'due_before'?"]);
    assert.deepEqual(validateArguments("t", schema, { zzz: 1 }), ["parameters: unknown argument 'zzz'"]);
  });

  test("the source opt-out lets it through", () => {
    assert.deepEqual(validateArguments("t", schema, { filtr: "today" }, { allowUnknownArguments: true }), []);
  });

  test("a schema that declares a map, or no properties, is left alone", () => {
    assert.deepEqual(validateArguments("t", { type: "object", properties: {}, additionalProperties: { type: "string" } }, { any: "x" }), []);
    assert.deepEqual(validateArguments("t", { type: "object" }, { any: "x" }), []);
  });

  test("additionalProperties: false reports the key once, with the suggestion", () => {
    const strict = { ...schema, additionalProperties: false };
    assert.deepEqual(validateArguments("t", strict, { limt: 5 }), ["parameters: unknown argument 'limt' - did you mean 'limit'?"]);
  });

  test("schema problems are still reported alongside", () => {
    const problems = validateArguments("t", { ...schema, required: ["filter"] }, { limit: "five" });
    assert.ok(problems.includes("parameters: missing required 'filter'"));
    assert.ok(problems.some((p) => p.startsWith("parameters.limit:")));
  });
});

/** Just enough of an index for search: names, services and descriptions. */
function index(tools: Array<[string, string]>): NexusIndex {
  const map = new Map<string, IndexedTool>();
  for (const [name, description] of tools) {
    const sourceId = name.slice(0, name.indexOf("__"));
    map.set(name, { sourceId, namespacedName: name, tool: { name: name.slice(sourceId.length + 2), description, inputSchema: { type: "object" } } });
  }
  return { tools: map } as NexusIndex;
}

describe("search", () => {
  test("a plural and another read verb still find the tool, at half weight", () => {
    const { tools } = index([
      ["todoist__todoist_task_get", "Retrieve tasks"],
      ["ms365__list-todo-tasks", "List To Do tasks"],
    ]);
    const { matches } = analyzeLexical("list my tasks", tools);
    const todoist = matches.find((m) => m.name === "todoist__todoist_task_get")!;
    assert.equal(todoist.nameHits, 2, "list~get and tasks~task both count as name evidence");
    assert.equal(matches[0].name, "ms365__list-todo-tasks", "the exact words still rank first");
  });

  test("an exact word outranks the same word reached through a variant", () => {
    const { tools } = index([
      ["ebay__ebay_get_order", "Get one order"],
      ["ebay__ebay_get_orders", "Get orders"],
    ]);
    assert.equal(analyzeLexical("ebay orders", tools).matches[0].name, "ebay__ebay_get_orders");
  });

  test("'use X instead' in a description places X right after it", () => {
    const description = "Does NOT expand recurring events. Use get-calendar-view instead to see occurrences.";
    assert.deepEqual(suggestedInstead(description), ["get-calendar-view"]);

    const { tools } = index([
      ["ms365__list-calendar-events", description],
      ["ms365__get-calendar-view", "Calendar view"],
      ["ms365__send-mail", "Send"],
    ]);
    const ranked = applySuggestions<{ name: string; suggestedBy?: string }>(
      [{ name: "ms365__list-calendar-events" }, { name: "ms365__send-mail" }],
      tools,
      () => true,
      (name, suggestedBy) => ({ name, suggestedBy }),
    );
    assert.deepEqual(ranked, [
      { name: "ms365__list-calendar-events" },
      { name: "ms365__get-calendar-view", suggestedBy: "ms365__list-calendar-events" },
      { name: "ms365__send-mail" },
    ]);

    const hidden = applySuggestions([{ name: "ms365__list-calendar-events" }], tools, (n) => n !== "ms365__get-calendar-view", (name) => ({ name }));
    assert.deepEqual(hidden, [{ name: "ms365__list-calendar-events" }], "a tool the client may not see is not suggested");
  });

  test("a failing embedding provider falls back to lexical, and status says so", async () => {
    const idx = index([["todoist__todoist_task_get", "Retrieve tasks"]]);
    const broken: EmbeddingProvider = {
      dimensions: 3,
      init: async () => {},
      embed: async () => {
        throw new Error("ollama is down");
      },
      embedBatch: async () => [],
    };
    const engine = new SearchEngine({ type: "hybrid", maxResults: 5, semantic: { provider: "ollama", batchSize: 1, minSimilarity: 0.25 } }, idx, broken);
    const { EmbeddingIndex } = await import("../src/search/semantic-search.js");
    engine.setEmbeddingIndex(new EmbeddingIndex(3));

    assert.equal(engine.status().semantic, "ok");
    const result = await engine.search("tasks");
    assert.equal(result.fellBackToLexical, true);
    assert.equal(result.results[0]?.name, "todoist__todoist_task_get");
    const status = engine.status();
    assert.equal(status.semantic, "failing");
    assert.equal(status.error, "ollama is down");
    assert.ok(status.lastFallbackAt);
  });

  test("a provider that never started is reported unavailable", () => {
    const engine = new SearchEngine({ type: "hybrid", maxResults: 5 }, index([]));
    engine.markUnavailable("model download failed");
    assert.deepEqual(engine.status(), { configured: "hybrid", semantic: "unavailable", error: "model download failed", lastFallbackAt: undefined });
  });

  test("visible narrows results before they are counted", async () => {
    const engine = new SearchEngine({ type: "lexical", maxResults: 5 }, index([
      ["ebay__ebay_get_orders", "Get orders"],
      ["ebay__ebay_issue_refund", "Refund an order"],
    ]));
    const result = await engine.search("order", undefined, (name) => name !== "ebay__ebay_issue_refund");
    assert.deepEqual(result.results.map((r) => r.name), ["ebay__ebay_get_orders"]);
    assert.equal(result.totalMatches, 1);
  });
});
