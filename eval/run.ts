/**
 * Offline relevance eval for search_tools.
 *
 * Runs every query in eval/queries.json against the committed corpus (eval/tools.json)
 * under each strategy and scores the top `maxResults` the way an agent sees them:
 *
 *   hit@k  — did any acceptable tool appear at all
 *   MRR    — 1 / rank of the first acceptable tool (0 when absent)
 *   empty  — for nonsense queries, did the search correctly return nothing
 *
 * It exists because ranking was changed three times on 26/09 on the strength of a
 * handful of hand-run queries, and each change exposed a failure the last one could
 * not have shown. With no measurement, a change that fixes one query and breaks two
 * reads as a fix.
 *
 * The baseline in eval/baseline.json is the gate: a strategy whose hit@k or MRR falls
 * below it, or a nonsense query that stops coming back empty, fails the run. Improve
 * the baseline deliberately with --update, in the same commit as the change that
 * earned it.
 *
 *   npm run eval                        # compare against the baseline
 *   npm run eval -- --update            # rewrite the baseline
 *   npm run eval -- --verbose           # per-query ranks
 *   EVAL_STRATEGIES=lexical,semantic npm run eval
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddingProvider, generateToolEmbeddings, getEmbeddingIndex, SearchEngine } from "../src/search/index.js";
import type { SearchConfig } from "../src/search/types.js";
import { corpusIndex, loadCorpus } from "./corpus.js";

interface Query {
  kind: string;
  query: string;
  serviceId?: string;
  expect: string[];
  note?: string;
}

interface Scores {
  hitAtK: number;
  mrr: number;
  emptyOk: number;
  /** Per query: rank of the first acceptable tool (0 = absent), or result count for nonsense. */
  ranks: Record<string, number>;
}

const here = dirname(fileURLToPath(import.meta.url));
const MAX_RESULTS = 5;
const MIN_SIMILARITY = 0.25;

const args = new Set(process.argv.slice(2));
const strategies = (process.env.EVAL_STRATEGIES ?? "lexical,semantic,hybrid").split(",") as SearchConfig["type"][];

const queries = JSON.parse(readFileSync(resolve(here, "queries.json"), "utf-8")) as Query[];
const index = corpusIndex(loadCorpus());

// One embedding pass shared by every strategy that needs it — the corpus is ~700
// tools and the model is local, so this is the slow step and worth doing once.
const semanticConfig = {
  provider: "built-in" as const,
  model: "Xenova/all-MiniLM-L6-v2",
  batchSize: 32,
  modelCachePath: process.env.EVAL_MODEL_CACHE ?? resolve(here, ".model-cache"),
  minSimilarity: MIN_SIMILARITY,
};
const needsEmbeddings = strategies.some((s) => s !== "lexical");
const provider = needsEmbeddings ? await createEmbeddingProvider({ type: "semantic", maxResults: MAX_RESULTS, semantic: semanticConfig }) : undefined;
const embeddingIndex = provider ? getEmbeddingIndex(provider) : undefined;
if (provider && embeddingIndex) await generateToolEmbeddings(index, provider, embeddingIndex, semanticConfig.batchSize);

const key = (q: Query) => (q.serviceId ? `${q.serviceId}: ${q.query}` : q.query);

async function score(type: SearchConfig["type"]): Promise<Scores> {
  const engine = new SearchEngine({ type, maxResults: MAX_RESULTS, semantic: semanticConfig }, index, provider);
  if (embeddingIndex) engine.setEmbeddingIndex(embeddingIndex);

  let hits = 0, rr = 0, relevant = 0, empties = 0, nonsense = 0;
  const ranks: Record<string, number> = {};

  for (const q of queries) {
    const { results } = await engine.search(q.query, q.serviceId);
    const names = results.map((r) => r.name);
    if (q.expect.length === 0) {
      nonsense++;
      if (names.length === 0) empties++;
      ranks[key(q)] = names.length;
      if (args.has("--verbose")) console.log(`  ${type.padEnd(8)} ${names.length === 0 ? "ok  " : "FAIL"} ${key(q)} -> ${names.slice(0, 3).join(", ")}`);
      continue;
    }
    relevant++;
    const rank = names.findIndex((n) => q.expect.includes(n)) + 1;
    if (rank > 0) { hits++; rr += 1 / rank; }
    ranks[key(q)] = rank;
    if (args.has("--verbose")) console.log(`  ${type.padEnd(8)} ${rank > 0 ? `#${rank}  ` : "miss"} ${key(q)}${rank !== 1 ? ` -> ${names.slice(0, 3).join(", ")}` : ""}`);
  }

  return { hitAtK: hits / relevant, mrr: rr / relevant, emptyOk: nonsense ? empties / nonsense : 1, ranks };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const current: Record<string, Scores> = {};
for (const s of strategies) {
  const r = await score(s);
  current[s] = { hitAtK: round(r.hitAtK), mrr: round(r.mrr), emptyOk: round(r.emptyOk), ranks: r.ranks };
}

console.log(`\n${queries.length} queries, top ${MAX_RESULTS}, minSimilarity ${MIN_SIMILARITY}\n`);
console.log("strategy   hit@5   MRR     nonsense empty");
for (const [s, r] of Object.entries(current)) {
  console.log(`${s.padEnd(10)} ${r.hitAtK.toFixed(3)}   ${r.mrr.toFixed(3)}   ${r.emptyOk.toFixed(3)}`);
}

const baselinePath = resolve(here, "baseline.json");
if (args.has("--update") || !existsSync(baselinePath)) {
  const merged = existsSync(baselinePath) ? { ...(JSON.parse(readFileSync(baselinePath, "utf-8")) as object), ...current } : current;
  writeFileSync(baselinePath, JSON.stringify(merged, null, 1) + "\n");
  console.log(`\nbaseline written -> ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Record<string, Scores>;
const failures: string[] = [];
for (const [s, r] of Object.entries(current)) {
  const b = baseline[s];
  if (!b) { failures.push(`${s}: no baseline - run with --update`); continue; }
  if (r.hitAtK < b.hitAtK) failures.push(`${s}: hit@5 ${r.hitAtK} < baseline ${b.hitAtK}`);
  if (r.mrr < b.mrr) failures.push(`${s}: MRR ${r.mrr} < baseline ${b.mrr}`);
  if (r.emptyOk < b.emptyOk) failures.push(`${s}: nonsense empty ${r.emptyOk} < baseline ${b.emptyOk}`);
}
if (failures.length > 0) {
  console.log(`\nREGRESSION\n${failures.map((f) => "  " + f).join("\n")}`);
  process.exit(1);
}
console.log("\nno regression against baseline");
