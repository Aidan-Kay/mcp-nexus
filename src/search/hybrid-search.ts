/** Hybrid search — reciprocal-rank fusion of semantic and lexical ranking */

import type { IndexedTool } from "../types.js";
import { analyzeLexical } from "./lexical-search.js";
import type { EmbeddingIndex } from "./semantic-search.js";
import type { MatchKind, SearchResult, SearchResultItem } from "./types.js";

/**
 * Reciprocal-rank-fusion constant. Ranks are damped rather than summed, so a tool
 * that is only moderately ranked by both strategies outranks one that is first by
 * a single strategy — which is the point of fusing two rankings that fail on
 * different queries. 60 is the value from the original RRF paper.
 */
export const RRF_K = 60;

/**
 * Normalise a name for exact comparison: split on anything that is not a letter or
 * digit and on camelCase boundaries, lowercase, and join the words with one space.
 * "todoist_task_update", "todoist-task-update" and "todoistTaskUpdate" all collapse
 * to "todoist task update". Unlike lexical scoring this keeps stopwords and the
 * service name — the caller typed a whole identifier and meant exactly that tool.
 */
function normalizeName(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

export interface HybridSearchOptions {
  query: string;
  tools: Map<string, IndexedTool>;
  embeddingIndex: EmbeddingIndex;
  queryEmbedding: Float32Array;
  minSimilarity: number;
  maxResults: number;
  serviceId?: string;
}

interface HybridCandidate {
  name: string;
  serviceId: string;
  fused: number;
  matched: MatchKind;
  pinned: boolean;
  isMatch: boolean;
}

/**
 * Fuse the semantic and lexical rankings of the scoped tools.
 *
 * The two rankings are kept separate from the match test: a tool can earn a lexical
 * rank (score > 0) without clearing the stronger name-hit bar for being called a
 * match, and that rank still pulls it up when the semantic side also finds it.
 */
export function hybridSearch(options: HybridSearchOptions): SearchResult {
  const { query, tools, embeddingIndex, queryEmbedding, minSimilarity, maxResults, serviceId } = options;

  // Semantic ranking. EmbeddingIndex.search drops non-positive similarity, so a tool
  // absent here has no semantic rank — and, since minSimilarity is above zero in any
  // calibrated config, is also not a semantic match.
  const semanticRank = new Map<string, number>();
  const similarity = new Map<string, number>();
  embeddingIndex.search(queryEmbedding, serviceId).forEach((hit, index) => {
    semanticRank.set(hit.name, index + 1);
    similarity.set(hit.name, hit.score);
  });

  // Lexical ranking. Every tool with a positive score gets a rank, whether or not it
  // clears the name-hit bar below.
  const lexical = analyzeLexical(query, tools, serviceId);
  const lexicalRank = new Map<string, number>();
  const nameHits = new Map<string, number>();
  lexical.matches.forEach((hit, index) => {
    lexicalRank.set(hit.name, index + 1);
    nameHits.set(hit.name, hit.nameHits);
  });

  const queryNormalized = normalizeName(query);
  // A lexical match needs two name hits, except when the query is a single word that
  // cannot produce two. Zero query words cannot produce any, so they never match.
  const nameHitFloor = Math.min(2, lexical.queryWordCount);

  const candidates: HybridCandidate[] = [];

  for (const [name, indexed] of tools) {
    if (serviceId && indexed.sourceId !== serviceId) continue;

    const bare = name.includes("__") ? name.slice(name.indexOf("__") + 2) : name;
    const pinned =
      queryNormalized.length > 0 && (normalizeName(name) === queryNormalized || normalizeName(bare) === queryNormalized);

    const sim = similarity.get(name);
    const semanticMatch = sim !== undefined && sim >= minSimilarity;
    const lexicalMatch = lexical.queryWordCount > 0 && (nameHits.get(name) ?? 0) >= nameHitFloor;

    const semRank = semanticRank.get(name);
    const lexRank = lexicalRank.get(name);
    const fused = (semRank ? 1 / (RRF_K + semRank) : 0) + (lexRank ? 1 / (RRF_K + lexRank) : 0);

    candidates.push({
      name,
      serviceId: indexed.sourceId,
      fused,
      matched: semanticMatch && lexicalMatch ? "both" : semanticMatch ? "semantic" : "lexical",
      pinned,
      isMatch: pinned || semanticMatch || lexicalMatch,
    });
  }

  candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.fused - a.fused || a.name.localeCompare(b.name));

  const matches = candidates.filter((c) => c.isMatch);
  const truncated = matches.length > maxResults;
  const results: SearchResultItem[] = matches.slice(0, maxResults).map((c) => ({
    name: c.name,
    serviceId: c.serviceId,
    matched: c.matched,
    ...(c.pinned ? { pinned: true as const } : {}),
  }));

  return {
    query,
    results,
    totalMatches: matches.length,
    truncated: truncated || undefined,
    strategy: "hybrid",
  };
}
