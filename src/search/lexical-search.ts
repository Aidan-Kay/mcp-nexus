/** Lexical search — substring scoring algorithm (extracted from nexus-server) */

import type { IndexedTool } from "../types.js";
import type { ScoredResult } from "./types.js";

/**
 * Score a tool against the query words.
 * Name matches are weighted 2×, description matches 1×.
 * Partial matches (substring) still surface but rank lower.
 */
export function lexicalSearch(query: string, tools: Map<string, IndexedTool>, serviceId?: string): ScoredResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const scored: ScoredResult[] = [];

  for (const [name, indexed] of tools) {
    if (serviceId && indexed.sourceId !== serviceId) continue;

    const toolName = name.toLowerCase();
    const desc = (indexed.tool.description ?? "").toLowerCase();
    let score = 0;

    for (const word of words) {
      if (toolName.includes(word)) score += 2;
      if (desc.includes(word)) score += 1;
    }

    if (score > 0) {
      scored.push({ name, serviceId: indexed.sourceId, score });
    }
  }

  // Sort by score descending, then alphabetically for stable ordering
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored;
}
