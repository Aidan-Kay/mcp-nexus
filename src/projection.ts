/**
 * Response shaping — content resolution, minification, projection and shape inference.
 *
 * Upstream MCP servers return a CallToolResult whose payload is normally a JSON
 * document serialised into a text content block. Several of them pretty-print it,
 * which is pure width with no value to an LLM. These helpers resolve that payload,
 * strip the formatting, and optionally project it down to the fields a caller asked
 * for — all while leaving non-JSON blocks (prose errors, images, resources) alone.
 */

// ─── Content Blocks ──────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | { type: string; [k: string]: unknown };

function isTextBlock(b: unknown): b is TextBlock {
  return typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Locate the first text block that parses as JSON.
 * Returns the parsed payload plus its index, or null when there is none —
 * in which case the content must be passed through untouched.
 */
export function resolveJsonBlock(content: ContentBlock[]): { index: number; data: unknown } | null {
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!isTextBlock(block)) continue;
    try {
      return { index: i, data: JSON.parse(block.text) as unknown };
    } catch {
      // Not JSON — keep looking; a server may emit prose before its payload
    }
  }
  return null;
}

/** Concatenate the text of every text block — used to inspect error payloads. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("\n");
}

/**
 * Re-serialise every JSON text block without whitespace.
 * Lossless: blocks that do not parse as JSON are returned exactly as received.
 */
export function minifyContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (!isTextBlock(block)) return block;
    try {
      return { ...block, text: JSON.stringify(JSON.parse(block.text)) };
    } catch {
      return block;
    }
  });
}

// ─── Path Projection ─────────────────────────────────────────────────────────

interface Segment {
  key: string;
  /** Segment ended in `[*]` — map over the array at this position */
  wildcard: boolean;
}

/**
 * Parse a dotted path into segments. `[*]` maps over an array.
 *   `inventoryItems[*].product.title` → items → product → title
 *   `[*].sku`                         → maps over a root-level array
 */
function parsePath(path: string): Segment[] {
  return path.split(".").map((raw) => {
    const wildcard = raw.endsWith("[*]");
    return { key: wildcard ? raw.slice(0, -3) : raw, wildcard };
  });
}

/**
 * Extract one path from `src`, rebuilding the nesting it was found under so
 * projections merge cleanly. Returns matched:false when the path does not exist,
 * which the caller surfaces rather than silently yielding an empty result.
 */
function buildPath(src: unknown, segments: Segment[]): { matched: boolean; value: unknown } {
  if (segments.length === 0) return { matched: true, value: src };

  const [segment, ...rest] = segments;
  let current: unknown = src;

  // An empty key means the segment was a bare `[*]` — stay at the current node
  if (segment.key !== "") {
    if (!isPlainObject(src) || !(segment.key in src)) return { matched: false, value: undefined };
    current = src[segment.key];
  }

  let inner: { matched: boolean; value: unknown };
  if (segment.wildcard) {
    if (!Array.isArray(current)) return { matched: false, value: undefined };
    const results = current.map((item) => buildPath(item, rest));
    inner = {
      // An empty array is a structural match — the path is valid, there is just nothing in it
      matched: current.length === 0 || results.some((r) => r.matched),
      value: results.map((r) => r.value),
    };
  } else {
    inner = buildPath(current, rest);
  }

  if (!inner.matched) return { matched: false, value: undefined };
  return { matched: true, value: segment.key === "" ? inner.value : { [segment.key]: inner.value } };
}

/** Deep-merge two projected fragments so multiple paths compose into one document. */
function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;

  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    return Array.from({ length }, (_, i) => merge(a[i], b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const key of Object.keys(b)) out[key] = merge(a[key], b[key]);
    return out;
  }

  return b;
}

/**
 * Project `data` down to `paths`, preserving the original nesting.
 * Paths that match nothing are reported — a typo must not look like absent data.
 */
export function project(data: unknown, paths: string[]): { result: unknown; unmatched: string[] } {
  let result: unknown;
  const unmatched: string[] = [];

  for (const path of paths) {
    const { matched, value } = buildPath(data, parsePath(path));
    if (!matched) {
      unmatched.push(path);
      continue;
    }
    result = merge(result, value);
  }

  return { result: result ?? {}, unmatched };
}

// ─── Shape Inference ─────────────────────────────────────────────────────────

const MAX_INFERRED_PATHS = 200;

/**
 * Describe the structure of a payload as a list of leaf paths and their types,
 * without any of the values. Arrays are sampled from their first element, so the
 * output stays small regardless of how many items came back.
 *
 * This is the only route to a response shape for upstream servers that declare no
 * outputSchema (the common case) — the LLM reads this to author a `select`.
 */
export function inferShape(data: unknown): string[] {
  const paths = new Set<string>();

  const walk = (value: unknown, prefix: string): void => {
    if (paths.size >= MAX_INFERRED_PATHS) return;

    if (Array.isArray(value)) {
      if (value.length > 0) walk(value[0], `${prefix}[*]`);
      else paths.add(`${prefix}[*]: empty array`);
      return;
    }

    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        walk(value[key], prefix ? `${prefix}.${key}` : key);
      }
      return;
    }

    paths.add(`${prefix}: ${value === null ? "null" : typeof value}`);
  };

  walk(data, "");
  return [...paths];
}
