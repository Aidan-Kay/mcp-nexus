/**
 * "Use X instead" — a service's own pointer from one of its tools to a better one.
 *
 * ms365's `list-calendar-events` says, in its description, that it does not expand
 * recurring events and to use `get-calendar-view` instead. Search ranked the tool
 * that says "not me" first, and the tool it pointed to nowhere: "calendar events
 * this week" names both words of the first and neither of the second. No amount of
 * ranking fixes that, because the evidence is not in the query — it is in the
 * service's own words, so this reads them.
 *
 * The suggested tool is placed directly after the one that names it, not before.
 * The pointer is often conditional ("if you are an attendee, use decline-calendar-
 * event instead"), so it earns the tool a place beside the match, not over it — and
 * the caller reads both descriptions together.
 */

import type { IndexedTool } from "../types.js";

const INSTEAD = /\b(?:use|call|try)\s+[`'"]?([a-z0-9][a-z0-9_-]{3,})[`'"]?\s+instead\b/gi;

/** Tool names a description recommends instead of itself, bare (as the service writes them). */
export function suggestedInstead(description: string | undefined): string[] {
  if (!description) return [];
  return [...description.matchAll(INSTEAD)].map((m) => m[1]);
}

export interface Ranked {
  name: string;
  /** Set on a tool placed here by another's pointer: the namespaced name that pointed. */
  suggestedBy?: string;
}

/**
 * Insert each suggested tool after the first ranked tool that names it, unless it
 * already ranks above that tool. `allowed` says whether a tool may appear at all
 * (in scope, visible to the client); a pointer to anything else is ignored.
 */
export function applySuggestions<T extends Ranked>(
  ranked: T[],
  tools: Map<string, IndexedTool>,
  allowed: (name: string) => boolean,
  make: (name: string, suggestedBy: string) => T,
): T[] {
  const out: T[] = [];
  const placed = new Set<string>();
  const pending = [...ranked];

  for (const item of pending) {
    if (placed.has(item.name)) continue;
    out.push(item);
    placed.add(item.name);

    const indexed = tools.get(item.name);
    if (!indexed) continue;
    for (const bare of suggestedInstead(indexed.tool.description)) {
      const target = `${indexed.sourceId}__${bare}`;
      if (target === item.name || placed.has(target) || !tools.has(target) || !allowed(target)) continue;
      const existing = ranked.find((r) => r.name === target);
      out.push(existing ? { ...existing, suggestedBy: item.name } : make(target, item.name));
      placed.add(target);
    }
  }
  return out;
}
