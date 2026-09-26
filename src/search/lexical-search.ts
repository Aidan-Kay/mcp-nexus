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

/** A lexical hit retains its name-hit count for hybrid's match test. */
export interface LexicalMatch extends ScoredResult {
  /** Distinct meaningful query words that matched a word of the tool name. */
  nameHits: number;
}

export interface LexicalAnalysis {
  matches: LexicalMatch[];
  /** Distinct query words actually scored (meaningful ones, or all for a stopword-only query). */
  queryWordCount: number;
}

/**
 * Score every scoped tool, keeping the name-hit count alongside the score.
 *
 * `score` is the lexical strategy's own score and keeps every name word: a query
 * that names a service ("list my todoist projects") must still find that service's
 * tools, so dropping the service word there would lose the hit entirely.
 *
 * `nameHits`, which hybrid uses to judge whether a query word is evidence for a
 * *specific* tool, ignores the words of the tool's serviceId. "todoist" matching the
 * name says which service, not which tool, so it must not count; for
 * `todoist__todoist_task_update` the hit words are "task" and "update".
 *
 * A query word matches a name or description word it is a prefix of, so "email"
 * finds "emails" and "creat" finds "create" — but never the middle of a word, which
 * is what let short words match almost everything when this was a substring test.
 */
export function analyzeLexical(query: string, tools: Map<string, IndexedTool>, serviceId?: string): LexicalAnalysis {
  const all = words(query);
  // A query made only of stopwords ("get it") still means something to its author;
  // searching on them beats returning nothing.
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  const queryWords = [...new Set(meaningful.length > 0 ? meaningful : all)];
  if (queryWords.length === 0) return { matches: [], queryWordCount: 0 };

  const matches = (word: string, haystack: string[]) => haystack.some((w) => w.startsWith(word));

  const scored: LexicalMatch[] = [];

  for (const [name, indexed] of tools) {
    if (serviceId && indexed.sourceId !== serviceId) continue;

    const nameWords = words(name);
    const serviceWords = new Set(words(indexed.sourceId));
    const nameHitWords = nameWords.filter((w) => !serviceWords.has(w));
    const descWords = words(indexed.tool.description ?? "");
    let score = 0;
    let nameHits = 0;

    for (const word of queryWords) {
      if (matches(word, nameWords)) score += 2;
      if (matches(word, descWords)) score += 1;
      if (matches(word, nameHitWords)) nameHits++;
    }

    if (score > 0) {
      scored.push({ name, serviceId: indexed.sourceId, score, nameHits });
    }
  }

  // Sort by score descending, then alphabetically for stable ordering
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return { matches: scored, queryWordCount: queryWords.length };
}

/** Plain lexical strategy: the scored tools, without the hybrid-only name-hit detail. */
export function lexicalSearch(query: string, tools: Map<string, IndexedTool>, serviceId?: string): ScoredResult[] {
  return analyzeLexical(query, tools, serviceId).matches;
}
