/** Lexical search — word-prefix scoring algorithm (extracted from nexus-server) */

import type { IndexedTool } from "../types.js";
import type { ScoredResult } from "./types.js";

/**
 * Words that carry no intent in a tool query. Without this, "send an email" matched
 * every tool whose name or description contained "an" — manage, channel, plan — and
 * the filler outscored the one word that meant anything.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "for", "from",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "some", "that", "the",
  "this", "to", "tool", "tools", "want", "what", "which", "with",
]);

/**
 * Split text into lowercase words: on anything that is not a letter or digit, and
 * on camelCase boundaries, so "outlook__search-emails" and "searchEmails" both
 * yield "search" and "emails".
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Score a tool against the query words.
 * Name matches are weighted 2×, description matches 1×.
 *
 * A query word matches a tool word it is a prefix of, so "email" finds "emails"
 * and "creat" finds "create" — but never the middle of a word, which is what let
 * short words match almost everything when this was a substring test.
 */
export function lexicalSearch(query: string, tools: Map<string, IndexedTool>, serviceId?: string): ScoredResult[] {
  const all = words(query);
  // A query made only of stopwords ("get it") still means something to its author;
  // searching on them beats returning nothing.
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  const queryWords = [...new Set(meaningful.length > 0 ? meaningful : all)];
  if (queryWords.length === 0) return [];

  const matches = (word: string, haystack: string[]) => haystack.some((w) => w.startsWith(word));

  const scored: ScoredResult[] = [];

  for (const [name, indexed] of tools) {
    if (serviceId && indexed.sourceId !== serviceId) continue;

    const nameWords = words(name);
    const descWords = words(indexed.tool.description ?? "");
    let score = 0;

    for (const word of queryWords) {
      if (matches(word, nameWords)) score += 2;
      if (matches(word, descWords)) score += 1;
    }

    if (score > 0) {
      scored.push({ name, serviceId: indexed.sourceId, score });
    }
  }

  // Sort by score descending, then alphabetically for stable ordering
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored;
}
