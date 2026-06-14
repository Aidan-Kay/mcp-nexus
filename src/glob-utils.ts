/** Shared glob matching utilities for tool filtering */

export function applyFilter<T extends { name: string }>(tools: T[], patterns: string[]): T[] {
  return tools.filter((t) => patterns.some((p) => matchGlob(t.name, p)));
}

/** Simple glob matcher — supports * and ? wildcards */
export function matchGlob(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`).test(name);
}
