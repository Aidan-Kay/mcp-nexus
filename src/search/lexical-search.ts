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
 * Verbs that mean "read me some records". Services disagree on which one they name
 * their read tools with — ms365 says `list-todo-tasks`, Todoist `todoist_task_get`,
 * Google `get_events` — while a person asks to "list my tasks" or "read my inbox"
 * whichever service holds them. Without this, "list" was evidence for ms365's tools
 * alone and Todoist's own read tool never cleared the name-hit bar for a match.
 */
const READ_VERBS = ["list", "get", "fetch", "retrieve", "show", "read"];

/** Alternatives a query word also matches as, itself first. */
function variants(word: string): string[] {
  if (READ_VERBS.includes(word)) return READ_VERBS;
  // A plural query word is cut to its singular, so "tasks" matches `task` as well as
  // `tasks` — the prefix rule already covers the other direction.
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return [word, word.slice(0, -1)];
  return [word];
}

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
 * It also matches through its variants (a plural's singular, another read verb) at
 * half weight.
 */
export function analyzeLexical(query: string, tools: Map<string, IndexedTool>, serviceId?: string): LexicalAnalysis {
  const all = words(query);
  // A query made only of stopwords ("get it") still means something to its author;
  // searching on them beats returning nothing.
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  const queryWords = [...new Set(meaningful.length > 0 ? meaningful : all)];
  if (queryWords.length === 0) return { matches: [], queryWordCount: 0 };

  // A word matched as itself scores in full; matched only through a variant, half. The
  // variant makes the tool findable, and the exact word still decides between two that
  // both are — "ebay orders" keeps ebay_get_orders above ebay_get_order.
  const expanded = new Map(queryWords.map((word) => [word, variants(word)]));
  const matchWeight = (word: string, haystack: string[]): number => {
    if (haystack.some((w) => w.startsWith(word))) return 1;
    return expanded.get(word)!.some((v) => v !== word && haystack.some((w) => w.startsWith(v))) ? 0.5 : 0;
  };

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
      score += 2 * matchWeight(word, nameWords) + matchWeight(word, descWords);
      // A variant counts in full here: this is evidence the tool is about the word,
      // and "list my tasks" must find Todoist's `task_get` as a match at all.
      if (matchWeight(word, nameHitWords) > 0) nameHits++;
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
