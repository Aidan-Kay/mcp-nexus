import { test } from "node:test";
import assert from "node:assert/strict";

import { namespaceTool, parseNamespacedName } from "../src/namespace.js";
import { matchGlob, compileFilterPatterns, applyFilter } from "../src/glob-utils.js";
import {
  selectPaths,
  inferShape,
  relevantShape,
  minifyContent,
  resolveJsonBlock,
  replaceJsonBlock,
} from "../src/response.js";
import type { ContentBlock } from "../src/response.js";
import { compactSchema } from "../src/compact-schema.js";

// ─── namespace.ts ────────────────────────────────────────────────────────────

test("namespaceTool joins source and tool with a double underscore", () => {
  assert.equal(namespaceTool("srv", "do_thing"), "srv__do_thing");
  assert.equal(namespaceTool("a", "b"), "a__b");
});

test("namespaceTool rejects a source id containing the delimiter", () => {
  assert.throws(() => namespaceTool("bad__id", "tool"), /reserved as the namespace delimiter/);
});

test("parseNamespacedName splits on the first delimiter", () => {
  assert.deepEqual(parseNamespacedName("srv__tool"), { sourceId: "srv", toolName: "tool" });
  assert.deepEqual(parseNamespacedName("a__b__c"), { sourceId: "a", toolName: "b__c" });
});

test("parseNamespacedName rejects malformed names", () => {
  assert.equal(parseNamespacedName("nodelimiter"), null);
  assert.equal(parseNamespacedName("__x"), null);
  assert.equal(parseNamespacedName("x__"), null);
  assert.equal(parseNamespacedName(""), null);
});

test("namespaceTool round-trips through parseNamespacedName", () => {
  assert.deepEqual(parseNamespacedName(namespaceTool("source", "tool")), {
    sourceId: "source",
    toolName: "tool",
  });
});

// ─── glob-utils.ts ───────────────────────────────────────────────────────────

test("matchGlob handles star and question wildcards and exact names", () => {
  assert.equal(matchGlob("abc", "abc"), true);
  assert.equal(matchGlob("abcd", "abc"), false);
  assert.equal(matchGlob("abc", "a*"), true);
  assert.equal(matchGlob("abc", "a?c"), true);
  assert.equal(matchGlob("ac", "a?c"), false);
  assert.equal(matchGlob("anything", "*"), true);
});

test("matchGlob treats regex metacharacters in the pattern literally", () => {
  assert.equal(matchGlob("a.b", "a.b"), true);
  assert.equal(matchGlob("axb", "a.b"), false);
  assert.equal(matchGlob("a+b", "a+b"), true);
  assert.equal(matchGlob("aab", "a+b"), false);
});

test("compileFilterPatterns rejects a pattern with more than ten wildcards", () => {
  assert.throws(() => compileFilterPatterns(["???????????"]), /11 wildcards \(max 10\)/);
  assert.doesNotThrow(() => compileFilterPatterns(["??????????"]));
});

test("applyFilter keeps only matching items", () => {
  const tools = [{ name: "read_file" }, { name: "write_file" }, { name: "list" }];
  assert.deepEqual(applyFilter(tools, ["*_file"]), [{ name: "read_file" }, { name: "write_file" }]);
  assert.deepEqual(applyFilter(tools, ["list"]), [{ name: "list" }]);
  assert.deepEqual(applyFilter(tools, ["nomatch*"]), []);
});

// ─── response.ts: selectPaths ────────────────────────────────────────────────

test("selectPaths extracts a single path", () => {
  assert.deepEqual(selectPaths({ a: 1, b: 2 }, ["a"]), { result: { a: 1 }, unmatched: [] });
});

test("selectPaths preserves nesting for a nested path", () => {
  const data = { a: { b: { c: 1, d: 2 } } };
  assert.deepEqual(selectPaths(data, ["a.b.c"]), { result: { a: { b: { c: 1 } } }, unmatched: [] });
});

test("selectPaths maps over an array with [*]", () => {
  const data = { items: [{ x: 1 }, { x: 2 }] };
  assert.deepEqual(selectPaths(data, ["items[*]"]), {
    result: { items: [{ x: 1 }, { x: 2 }] },
    unmatched: [],
  });
});

test("selectPaths maps a root-level array with [*]", () => {
  const data = [{ x: 1 }, { x: 2 }];
  assert.deepEqual(selectPaths(data, ["[*].x"]), { result: [{ x: 1 }, { x: 2 }], unmatched: [] });
});

test("selectPaths merges several paths preserving nesting", () => {
  const data = {
    user: { id: 1, name: "Ada", address: { city: "London", zip: "E1" } },
    meta: { page: 2, tags: ["a", "b"] },
  };
  assert.deepEqual(selectPaths(data, ["user.id", "user.address.city", "meta.tags[*]"]), {
    result: { user: { id: 1, address: { city: "London" } }, meta: { tags: ["a", "b"] } },
    unmatched: [],
  });
});

test("selectPaths reports unmatched paths", () => {
  assert.deepEqual(selectPaths({ a: 1 }, ["nope"]), { result: {}, unmatched: ["nope"] });
  assert.deepEqual(selectPaths({ a: 1 }, ["a", "bad.path"]), { result: { a: 1 }, unmatched: ["bad.path"] });
});

test("selectPaths treats an empty array as a structural match", () => {
  assert.deepEqual(selectPaths({ items: [] }, ["items[*].name"]), { result: { items: [] }, unmatched: [] });
});

// ─── response.ts: inferShape ─────────────────────────────────────────────────

test("inferShape lists leaf paths with their types", () => {
  assert.deepEqual(inferShape({ a: 1, b: "x", c: true }), ["a: number", "b: string", "c: boolean"]);
});

test("inferShape samples arrays from the first element as [*]", () => {
  assert.deepEqual(inferShape({ items: [{ x: 1, y: "a" }, { x: 2, y: "b" }] }), [
    "items[*].x: number",
    "items[*].y: string",
  ]);
});

test("inferShape reports an empty array", () => {
  assert.deepEqual(inferShape({ x: [] }), ["x[*]: empty array"]);
});

test("inferShape types null as null", () => {
  assert.deepEqual(inferShape({ a: null }), ["a: null"]);
});

// ─── response.ts: relevantShape ──────────────────────────────────────────────

test("relevantShape narrows to the failed path's parent prefix", () => {
  const shape = ["user.name: string", "user.age: number", "other: string"];
  assert.deepEqual(relevantShape(shape, ["user.missing"]), {
    paths: ["user.name: string", "user.age: number"],
    omitted: 0,
  });
});

test("relevantShape falls back to the whole shape capped by limit for a root-level path", () => {
  const shape = ["a: number", "b: string", "c: boolean"];
  assert.deepEqual(relevantShape(shape, ["missing"], 2), {
    paths: ["a: number", "b: string"],
    omitted: 1,
  });
});

test("relevantShape reports omitted entries above the limit", () => {
  const shape = ["user.a: number", "user.b: number", "user.c: boolean"];
  assert.deepEqual(relevantShape(shape, ["user.x"], 2), {
    paths: ["user.a: number", "user.b: number"],
    omitted: 1,
  });
});

// ─── response.ts: minifyContent / resolveJsonBlock / replaceJsonBlock ────────

test("minifyContent re-serialises JSON text blocks without whitespace", () => {
  const content: ContentBlock[] = [{ type: "text", text: '{\n  "a": 1,\n  "b": [1, 2]\n}', extra: true }];
  assert.deepEqual(minifyContent(content), [{ type: "text", text: '{"a":1,"b":[1,2]}', extra: true }]);
});

test("minifyContent leaves non-JSON text and non-text blocks untouched", () => {
  const prose: ContentBlock = { type: "text", text: "not json" };
  const image: ContentBlock = { type: "image", data: "abc" };
  const result = minifyContent([prose, image]);
  assert.equal(result[0], prose);
  assert.equal(result[1], image);
});

test("resolveJsonBlock skips prose and returns the first JSON block with its index", () => {
  const content: ContentBlock[] = [
    { type: "text", text: "an error occurred" },
    { type: "text", text: '{"ok":true}' },
  ];
  assert.deepEqual(resolveJsonBlock(content), { index: 1, data: { ok: true } });
});

test("resolveJsonBlock returns null when no block parses as JSON", () => {
  const content: ContentBlock[] = [{ type: "text", text: "prose" }, { type: "image", data: "x" }];
  assert.equal(resolveJsonBlock(content), null);
});

test("replaceJsonBlock with index -1 returns a single fresh text block", () => {
  const content: ContentBlock[] = [{ type: "text", text: "old" }];
  assert.deepEqual(replaceJsonBlock(content, -1, { a: 1 }), [{ type: "text", text: '{"a":1}' }]);
});

test("replaceJsonBlock replaces the block at index and leaves the rest", () => {
  const content: ContentBlock[] = [{ type: "text", text: "old" }, { type: "text", text: "keep" }];
  assert.deepEqual(replaceJsonBlock(content, 0, { a: 1 }), [
    { type: "text", text: '{"a":1}' },
    { type: "text", text: "keep" },
  ]);
});

// ─── compact-schema.ts ───────────────────────────────────────────────────────

test("compactSchema keeps scalar, enum and scalar-array properties whole", () => {
  const input = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "number" },
      status: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  assert.deepEqual(compactSchema(input), { schema: input });
  assert.equal(compactSchema(input).trimmed, undefined);
});

test("compactSchema keeps a flat object of scalars whole", () => {
  const input = {
    type: "object",
    properties: {
      coords: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } } },
    },
  };
  assert.deepEqual(compactSchema(input), { schema: input });
  assert.equal(compactSchema(input).trimmed, undefined);
});

test("compactSchema cuts an object with a nested object and names it in trimmed", () => {
  const input = {
    type: "object",
    properties: {
      config: {
        type: "object",
        description: "config value",
        properties: { nested: { type: "object", properties: { x: { type: "string" } } } },
      },
    },
  };
  assert.deepEqual(compactSchema(input), {
    schema: {
      type: "object",
      properties: { config: { type: "object", description: "config value" } },
    },
    trimmed: ["config"],
  });
});

test("compactSchema cuts an array of objects and names it in trimmed", () => {
  const input = {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object", properties: { id: { type: "number" } } } },
    },
  };
  assert.deepEqual(compactSchema(input), {
    schema: { type: "object", properties: { rows: { type: "array" } } },
    trimmed: ["rows"],
  });
});

test("compactSchema cuts a $ref and drops $defs", () => {
  const input = {
    type: "object",
    $defs: { Foo: { type: "object", properties: { x: { type: "string" } } } },
    properties: { ref: { $ref: "#/$defs/Foo" } },
  };
  assert.deepEqual(compactSchema(input), {
    schema: { type: "object", properties: { ref: { type: "object" } } },
    trimmed: ["ref"],
  });
});

test("compactSchema passes through schemas without object properties", () => {
  assert.deepEqual(compactSchema(null), { schema: null });
  assert.deepEqual(compactSchema("nope"), { schema: "nope" });
  assert.deepEqual(compactSchema({ type: "object" }), { schema: { type: "object" } });
});
