/**
 * A minimal stdio MCP server for the call_tool tests: just enough of the protocol for
 * the nexus to index it and call its tools, with each tool shaped to provoke one
 * behaviour — text output, JSON output, a destructive annotation, an oversized
 * response, a slow call.
 */

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "get_tasks",
    description: "Retrieve tasks. Returns plain text, as Todoist's task tools do.",
    inputSchema: { type: "object", properties: { filter: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "get_orders",
    description: "Retrieve orders as JSON.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "big",
    description: "Return a response of the requested size.",
    inputSchema: { type: "object", properties: { bytes: { type: "number" } }, required: ["bytes"] },
  },
  {
    name: "slow",
    description: "Answer after a delay.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
  },
];

const text = (value) => ({ content: [{ type: "text", text: value }] });

function call(name, args) {
  switch (name) {
    case "get_tasks":
      return text(`2 tasks, arguments received: ${JSON.stringify(args)}`);
    case "get_orders":
      return text(JSON.stringify({ total: 2, orders: [{ id: 1, buyer: "ann" }, { id: 2, buyer: "bob" }] }, null, 2));
    case "delete_event":
      return text(JSON.stringify({ deleted: args.id }));
    case "big":
      return text("x".repeat(args.bytes));
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return; // a notification
  const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });

  switch (request.method) {
    case "initialize":
      return reply({ protocolVersion: "2025-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = request.params;
      if (name === "slow") return void setTimeout(() => reply(text("done")), args.ms);
      return reply(call(name, args));
    }
    default:
      return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
