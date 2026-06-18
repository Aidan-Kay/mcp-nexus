/** Shared glob matching utilities for tool filtering */

const MAX_WILDCARDS = 10;

/** Compile a glob pattern into a RegExp. Caches results for reuse. */
const regexCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  if (pattern === "*") {
    const re = /^.*$/;
    regexCache.set(pattern, re);
    return re;
  }

  // Guard against catastrophic backtracking from excessive wildcards
  const wildcardCount = (pattern.match(/\*/g) ?? []).length + (pattern.match(/\?/g) ?? []).length;
  if (wildcardCount > MAX_WILDCARDS) {
    throw new Error(
      `Glob pattern "${pattern}" has ${wildcardCount} wildcards (max ${MAX_WILDCARDS}). ` +
        "Reduce wildcard count to prevent catastrophic backtracking.",
    );
  }

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${regexStr}$`);
  regexCache.set(pattern, re);
  return re;
}

/** Pre-compile an array of glob patterns into RegExp objects. Call at config load time. */
export function compileFilterPatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => compilePattern(p));
}

export function applyFilter<T extends { name: string }>(tools: T[], patterns: string[]): T[] {
  const regexes = compileFilterPatterns(patterns);
  return tools.filter((t) => regexes.some((re) => re.test(t.name)));
}

/** Simple glob matcher — supports * and ? wildcards */
export function matchGlob(name: string, pattern: string): boolean {
  return compilePattern(pattern).test(name);
}
