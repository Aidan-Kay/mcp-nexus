/**
 * Snapshot the live tool corpus into eval/tools.json.
 *
 * The relevance eval runs offline against a committed corpus, so a ranking change is
 * measured against the tools it will actually meet rather than a handful written to
 * suit it. This refreshes that corpus from a running nexus. Run it when the upstream
 * tool set has moved enough that the eval no longer reflects it, and re-baseline in
 * the same commit — a baseline is only comparable against the corpus it was taken on.
 *
 * Only what search reads is kept: the name, the description and the parameter
 * *names*. Parameter descriptions are left out on purpose — search never embeds them
 * (see toolToText), and some carry account addresses that have no business in a
 * committed file.
 *
 *   NEXUS_URL=https://nexus.example/mcp NEXUS_TOKEN=... npm run eval:snapshot
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { CorpusTool } from "./corpus.js";

const url = process.env.NEXUS_URL;
const token = process.env.NEXUS_TOKEN;
if (!url || !token) {
  console.error("NEXUS_URL and NEXUS_TOKEN must be set");
  process.exit(2);
}

const client = new Client({ name: "mcp-nexus-eval-snapshot", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

/** Nexus tools answer with one JSON text block. */
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const block = (result.content as Array<{ type: string; text?: string }>)[0];
  if (result.isError || block?.type !== "text" || !block.text) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return JSON.parse(block.text) as T;
}

const services = await call<Array<{ id: string; status: string }>>("browse_services");
const down = services.filter((s) => s.status !== "ok").map((s) => s.id);
if (down.length > 0) {
  // A snapshot missing a service would silently drop its queries' targets.
  console.error(`refusing to snapshot while sources are unavailable: ${down.join(", ")}`);
  process.exit(1);
}

const tools: CorpusTool[] = [];
for (const { id } of services) {
  const { tools: names } = await call<{ tools: string[] }>("browse_tools", { serviceId: id });
  // get_schemas takes a batch; keep requests a sensible size.
  for (let i = 0; i < names.length; i += 50) {
    const { schemas } = await call<{ schemas: Array<{ toolName: string; description?: string; inputSchema?: { properties?: object } }> }>(
      "get_schemas",
      { toolNames: names.slice(i, i + 50) },
    );
    for (const s of schemas) {
      tools.push({
        name: s.toolName,
        serviceId: id,
        description: s.description ?? "",
        params: Object.keys(s.inputSchema?.properties ?? {}),
      });
    }
  }
}
await client.close();

tools.sort((a, b) => a.name.localeCompare(b.name));
const out = resolve(dirname(fileURLToPath(import.meta.url)), "tools.json");
writeFileSync(out, JSON.stringify(tools, null, 1) + "\n");
console.log(`${tools.length} tools from ${services.length} services -> ${out}`);
