/**
 * Artefacts — writing tool results to files instead of returning them.
 *
 * A wide response costs the same tokens whether an agent reads all of it or not.
 * When a caller passes an `artefacts` label to call_tool, the projected payload is
 * written to a file under a run directory and only a receipt comes back — so the
 * data reaches no LLM context at all and is read instead by whatever executes code
 * against the same path (on firelink, Jupyter mounts the directory read-only).
 *
 * The label is a *label*, never a path: the caller names the run, this module owns
 * every byte of the filesystem path it turns into.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { logger } from "./logger.js";
import { inferShape } from "./projection.js";
import type { ArtefactsConfig } from "./types.js";

/** Run directories this module created — the only thing the prune is allowed to delete. */
const RUN_DIR_PATTERN = /^\d{8}-\d{6}-[a-z0-9-]*$/;

/** Leaf paths reported on an artefact's first write. Matches the cap used for select errors. */
const SHAPE_LIMIT = 40;

const DAY_MS = 86_400_000;

// ─── Naming ──────────────────────────────────────────────────────────────────

/**
 * Reduce a caller-supplied label to `[a-z0-9-]`.
 *
 * This is the containment boundary, not the `resolve()` assertion below it: the
 * sanitised label is interpolated into a name this module constructs, so `../../app`
 * arrives as `app` and there is no traversal left to catch.
 */
export function sanitiseLabel(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return cleaned || "run";
}

/** Local-time `YYYYMMDD-HHMMSS`, so a directory listing sorts chronologically. */
function timestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Join under `root` and assert the result stayed there.
 *
 * Belt-and-braces: every name reaching this function is already one this module
 * built out of sanitised parts. It exists so that a future caller passing something
 * less careful fails loudly rather than writing outside the artefacts tree.
 */
function safeJoin(root: string, name: string): string {
  const base = resolve(root);
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`artefact path escaped the artefacts root: ${target}`);
  }
  return target;
}

/** Sort object keys at every depth so equivalent parameters hash identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return value;
}

/**
 * Name a file from the tool plus a digest of the arguments that produced it.
 *
 * Deterministic on purpose: a retried page overwrites itself rather than leaving a
 * second copy for the aggregation to double-count. `select` is part of the digest
 * so two calls differing only in projection do not collide on one filename.
 */
function fileStem(toolName: string, parameters: Record<string, unknown>, select: string[] | undefined): string {
  const stem = toolName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "tool";
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical({ parameters, select: select ?? null })))
    .digest("hex")
    .slice(0, 8);
  return `${stem}-${digest}`;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

interface RunState {
  /** Directory name — `20260824-161204-ebay-weekly-review` */
  run: string;
  /** Absolute path to the run directory */
  dir: string;
  lastUsed: number;
  /** Tools that have already written here — response shape is reported once per tool */
  toolsSeen: Set<string>;
}

/**
 * Sanitised label → run, so every call in a task lands in one directory.
 *
 * Keyed process-wide rather than per MCP session: parallel sub-agents arrive on
 * separate sessions and still have to converge on the same folder. A run goes stale
 * after `runIdleMinutes` of no writes, which is what stops next week's pull from
 * appending to last week's — and reading a stale page as if it were current is
 * precisely the failure a per-page record count exists to catch.
 */
const runs = new Map<string, RunState>();

export function resolveRun(config: ArtefactsConfig, label: string): RunState {
  const key = sanitiseLabel(label);
  const now = Date.now();

  const existing = runs.get(key);
  if (existing && now - existing.lastUsed <= config.runIdleMinutes * 60_000 && existsSync(existing.dir)) {
    existing.lastUsed = now;
    return existing;
  }

  const run = `${timestamp()}-${key}`;
  const dir = safeJoin(config.root, run);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // mkdir's mode is masked by the process umask; the consumer runs as a different
  // uid and needs the x bit to traverse, so set it explicitly rather than inherit it.
  chmodSync(dir, 0o755);

  const state: RunState = { run, dir, lastUsed: now, toolsSeen: new Set() };
  runs.set(key, state);
  logger.info(`Artefact run ${run} → ${dir}`);
  return state;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export interface ArtefactResult {
  run: string;
  dir: string;
  path: string;
  bytes: number;
  /** Length of the payload's largest top-level array — how a dropped page is spotted */
  records?: number;
  /** Which key `records` counted */
  recordPath?: string;
  /** Leaf paths of what is *in the file*, first write per tool per run */
  shape?: string[];
  shapeOmitted?: number;
}

/**
 * Count the records in a payload.
 *
 * A per-file count is what lets a caller check that pages sum to the feed total
 * without opening anything. The largest top-level array is the record set in every
 * response shape seen so far; a payload that is itself an array is counted directly.
 */
export function countRecords(payload: unknown): { records?: number; recordPath?: string } {
  if (Array.isArray(payload)) return { records: payload.length, recordPath: "[*]" };

  if (payload && typeof payload === "object") {
    let best: { records: number; recordPath: string } | undefined;
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (Array.isArray(value) && (!best || value.length > best.records)) {
        best = { records: value.length, recordPath: key };
      }
    }
    if (best) return best;
  }

  return {};
}

/**
 * Write one artefact into `state`'s directory and describe it.
 *
 * `payload` is the projected JSON — what the caller would otherwise have received,
 * after any configured projection or explicit `select`. When the response carried no
 * JSON at all, `text` is written verbatim instead and there is nothing to count.
 *
 * Throws on any filesystem failure; the caller reports it rather than falling back
 * to returning the payload, which would land the whole response in context at exactly
 * the moment the caller was trying to keep it out.
 */
export function writeArtefact(
  config: ArtefactsConfig,
  state: RunState,
  opts: {
    toolName: string;
    parameters: Record<string, unknown>;
    select?: string[];
    payload: unknown;
    text: string;
  },
): ArtefactResult {
  const isJson = opts.payload !== undefined;
  const body = isJson ? JSON.stringify(opts.payload) : opts.text;
  const bytes = Buffer.byteLength(body, "utf-8");

  if (bytes > config.maxBytes) {
    throw new Error(`artefact is ${bytes} bytes, over the configured maxBytes of ${config.maxBytes}`);
  }

  const path = safeJoin(state.dir, `${fileStem(opts.toolName, opts.parameters, opts.select)}.${isJson ? "json" : "txt"}`);

  // Write-then-rename: a retry overwrites atomically, so a reader on the shared
  // mount can never open a half-written file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf-8", mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);

  state.lastUsed = Date.now();

  const result: ArtefactResult = {
    run: state.run,
    dir: state.dir,
    path,
    bytes,
    ...(isJson ? countRecords(opts.payload) : {}),
  };

  // The shape of the *file*, not of the upstream response — a projection removed
  // fields that are in one and not the other, and code is about to be written
  // against the file. Reported once per tool per run: seven pages share a shape.
  if (isJson && !state.toolsSeen.has(opts.toolName)) {
    const all = inferShape(opts.payload);
    result.shape = all.slice(0, SHAPE_LIMIT);
    const omitted = all.length - result.shape.length;
    if (omitted > 0) result.shapeOmitted = omitted;
  }
  state.toolsSeen.add(opts.toolName);

  logger.info(`Artefact ${path} (${bytes} bytes${result.records !== undefined ? `, ${result.records} records` : ""})`);
  return result;
}

// ─── Retention ───────────────────────────────────────────────────────────────

let pruneTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Delete run directories older than the retention window.
 *
 * Only directories matching this module's own naming pattern are candidates —
 * anything else sharing the root is left alone, whoever put it there. A root
 * shallower than two path segments is refused outright.
 */
export function pruneRuns(config: ArtefactsConfig): void {
  if (config.retentionDays <= 0) return;

  const base = resolve(config.root);
  if (base.split(sep).filter(Boolean).length < 2) {
    logger.warn(`Refusing to prune artefacts: root '${base}' is too shallow to delete from safely`);
    return;
  }

  const cutoff = Date.now() - config.retentionDays * DAY_MS;
  let removed = 0;

  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    logger.warn(`Could not read artefacts root ${base}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_DIR_PATTERN.test(entry.name)) continue;

    const dir = join(base, entry.name);
    try {
      if (statSync(dir).mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn(`Could not prune ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (removed > 0) {
    logger.info(`Pruned ${removed} artefact run(s) older than ${config.retentionDays} day(s)`);
  }
}

/**
 * Create the artefacts root, prune what has aged out, and arm a daily prune.
 * A no-op when artefacts are not configured.
 */
export function initArtefacts(config?: ArtefactsConfig): void {
  if (!config) return;

  const base = resolve(config.root);
  mkdirSync(base, { recursive: true, mode: 0o755 });
  logger.info(`Artefacts enabled: root=${base}, retention=${config.retentionDays}d, runIdle=${config.runIdleMinutes}m`);

  pruneRuns(config);

  // A container can run for months, so startup-only retention would never fire.
  if (config.retentionDays > 0 && !pruneTimer) {
    pruneTimer = setInterval(() => pruneRuns(config), DAY_MS);
    if (typeof pruneTimer === "object" && "unref" in pruneTimer) pruneTimer.unref();
  }
}

export function stopArtefacts(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = undefined;
  }
}
