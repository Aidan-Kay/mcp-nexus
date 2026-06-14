/** Tool name namespacing: <sourceId>__<toolName> (double-underscore delimiter) */

const DELIMITER = "__";

/** Validate that a source ID contains no double-underscore (would break parsing) */
function assertValidSourceId(id: string): void {
  if (id.includes(DELIMITER)) {
    throw new Error(`Source ID "${id}" contains "${DELIMITER}" which is reserved as the namespace delimiter`);
  }
}

export function namespaceTool(sourceId: string, toolName: string): string {
  assertValidSourceId(sourceId);
  return `${sourceId}${DELIMITER}${toolName}`;
}

/** Split a namespaced name back into sourceId + toolName. Returns null if malformed. */
export function parseNamespacedName(namespaced: string): { sourceId: string; toolName: string } | null {
  const idx = namespaced.indexOf(DELIMITER);
  if (idx <= 0) return null; // no delimiter or empty sourceId
  const sourceId = namespaced.slice(0, idx);
  const toolName = namespaced.slice(idx + DELIMITER.length);
  if (!sourceId || !toolName) return null; // reject empty segments
  return { sourceId, toolName };
}
