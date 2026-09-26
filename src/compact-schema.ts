/**
 * Compact input schemas for search results.
 *
 * search_tools returns a schema with every hit so a simple tool can be called straight
 * from the search. But a Graph-backed ms365 tool resolves whole entities into its schema
 * — send-mail carries the full message object — and five of those made one search a
 * multi-thousand-token response when the caller was often only looking for a name.
 *
 * So search keeps each top-level argument whole when it is simple (scalars, enums,
 * arrays of scalars, unions of those) and cuts a structured one down to its type and
 * description, naming it in `trimmed`. Most tools have no structured arguments, so
 * their compact schema *is* the full one and they can be called directly; for the rest
 * the trimmed names say exactly when get_schemas is needed.
 */

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when a schema describes no nested structure the caller has to build. */
function isSimple(schema: unknown): boolean {
  if (!isObject(schema)) return true;
  if ("$ref" in schema || "properties" in schema || "patternProperties" in schema) return false;
  // A map is simple when its values are: { [k]: string } is fully described already.
  if ("additionalProperties" in schema && !isSimple(schema.additionalProperties)) return false;
  if ("items" in schema && !isSimple(schema.items)) return false;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches) && !branches.every(isSimple)) return false;
  }
  return true;
}

export interface CompactSchema {
  schema: unknown;
  /** Top-level arguments cut to type and description; absent when nothing was cut. */
  trimmed?: string[];
}

export function compactSchema(inputSchema: unknown): CompactSchema {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return { schema: inputSchema };

  const properties: Schema = {};
  const trimmed: string[] = [];

  for (const [name, prop] of Object.entries(inputSchema.properties)) {
    if (isSimple(prop)) {
      properties[name] = prop;
      continue;
    }
    const { type, description } = isObject(prop) ? prop : ({} as Schema);
    properties[name] = { type: type ?? "object", ...(description !== undefined ? { description } : {}) };
    trimmed.push(name);
  }

  if (trimmed.length === 0) return { schema: inputSchema };

  // $defs/definitions only serve the $refs just cut away, and are often the bulk.
  const { $defs: _defs, definitions: _definitions, ...rest } = inputSchema;
  return { schema: { ...rest, properties }, trimmed };
}
