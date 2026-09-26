/** The committed tool corpus, and its conversion into the index shape search reads. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { IndexedTool, NexusIndex } from "../src/types.js";

export interface CorpusTool {
  name: string;
  serviceId: string;
  description: string;
  /** Parameter names only — the part of the schema search reads. */
  params: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadCorpus(): CorpusTool[] {
  return JSON.parse(readFileSync(resolve(here, "tools.json"), "utf-8")) as CorpusTool[];
}

/** Just enough of a NexusIndex for SearchEngine: the tool map is all search reads. */
export function corpusIndex(corpus: CorpusTool[]): NexusIndex {
  const tools = new Map<string, IndexedTool>();
  for (const t of corpus) {
    tools.set(t.name, {
      namespacedName: t.name,
      sourceId: t.serviceId,
      tool: {
        name: t.name.slice(t.serviceId.length + 2),
        description: t.description,
        inputSchema: { type: "object", properties: Object.fromEntries(t.params.map((p) => [p, {}])) },
      },
    } as IndexedTool);
  }
  return { tools } as NexusIndex;
}
