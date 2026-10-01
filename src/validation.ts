/**
 * Argument validation for call_tool, against the schema the upstream declared.
 *
 * A malformed call used to cost a full round trip to the upstream service, whose
 * error names the problem in its own words and never shows the schema, so the
 * agent's next move was get_schemas and then a second attempt. Checking here lets
 * the refusal carry the schema itself: one failed call, one corrected call.
 *
 * The validator is deliberately lenient about the schema and strict only about the
 * arguments. Upstream schemas are written by many hands and not all of them are
 * valid JSON Schema; a schema this cannot compile is skipped, never used to refuse,
 * because refusing a call the upstream would have accepted is worse than the round
 * trip this saves. For the same reason formats are not checked — a "date-time" the
 * upstream parses leniently must not be refused here on a stricter reading.
 *
 * The one place it is stricter than the schema is unknown top-level arguments. Most
 * upstreams leave `additionalProperties` unset, which JSON Schema reads as "anything
 * goes", and the services then ignore keys they do not know. So a misspelt filter
 * (`due_date` for `due_before`) reached Todoist, was dropped there, and every task
 * came back — a wrong answer with nothing to say it was wrong. An argument the tool
 * does not declare is refused here whatever the schema says; a source whose tools
 * really do take extra keys sets `allowUnknownArguments`.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { logger } from "./logger.js";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

/** Compiled validators, keyed by the schema object so a re-index compiles afresh. */
const compiled = new WeakMap<object, ValidateFunction | null>();

function validatorFor(toolName: string, schema: unknown): ValidateFunction | null {
  if (!schema || typeof schema !== "object") return null;

  const cached = compiled.get(schema);
  if (cached !== undefined) return cached;

  let validate: ValidateFunction | null = null;
  try {
    // A $schema naming a draft this instance was not built with makes compile throw;
    // the keywords upstreams actually use read the same across drafts, so drop it.
    const { $schema: _ignored, ...body } = schema as Record<string, unknown>;
    validate = ajv.compile(body);
  } catch (err) {
    logger.warn(`Input schema for ${toolName} does not compile — its arguments go unchecked: ${err instanceof Error ? err.message : String(err)}`);
  }
  compiled.set(schema, validate);
  return validate;
}

/** One line per problem, phrased against the argument path rather than Ajv's pointer. */
function describe(error: ErrorObject): string {
  const at = error.instancePath ? `parameters${error.instancePath.replace(/\//g, ".")}` : "parameters";
  switch (error.keyword) {
    case "required":
      return `${at}: missing required '${(error.params as { missingProperty: string }).missingProperty}'`;
    case "additionalProperties":
      return `${at}: unknown argument '${(error.params as { additionalProperty: string }).additionalProperty}'`;
    case "enum":
      return `${at}: must be one of ${JSON.stringify((error.params as { allowedValues: unknown[] }).allowedValues)}`;
    default:
      return `${at}: ${error.message ?? error.keyword}`;
  }
}

/** Edit distance, for suggesting the argument a misspelt one was probably meant to be. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The declared argument closest to `name`, when one is close enough to be a typo of it
 * or shares its first word (`due_date` → `due_before`). Undefined when nothing is.
 */
function nearest(name: string, declared: string[]): string | undefined {
  const lowered = name.toLowerCase();
  const stem = name.split(/[_\-.]|(?=[A-Z])/)[0].toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const candidate of declared) {
    const d = distance(lowered, candidate.toLowerCase());
    const sharesStem = stem.length >= 3 && candidate.toLowerCase().startsWith(stem);
    const close = d <= Math.max(1, Math.floor(name.length / 4));
    if (!close && !sharesStem) continue;
    if (!best || d < best.score) best = { name: candidate, score: d };
  }
  return best?.name;
}

/**
 * Whether the schema declares, in its own words, that it takes keys it does not name:
 * a schema-valued `additionalProperties` or any `patternProperties`. That is a map, not
 * an omission, and is left alone. `additionalProperties: true` is not counted — it is
 * what a schema generator writes by default, and says nothing about the tool.
 */
function declaresOpenKeys(schema: Record<string, unknown>): boolean {
  const extra = schema.additionalProperties;
  return (typeof extra === "object" && extra !== null) || schema.patternProperties !== undefined;
}

/** Top-level arguments the schema does not declare, each with a suggestion when there is one. */
function unknownArguments(schema: unknown, parameters: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const body = schema as Record<string, unknown>;
  const properties = body.properties;
  // No property list to check against: a free-form tool, or one whose schema is not
  // an object schema at all. Guessing would refuse calls the upstream accepts.
  if (!properties || typeof properties !== "object" || declaresOpenKeys(body)) return [];

  const declared = Object.keys(properties);
  return Object.keys(parameters)
    .filter((key) => !declared.includes(key))
    .map((key) => {
      const suggestion = nearest(key, declared);
      return `parameters: unknown argument '${key}'${suggestion ? ` - did you mean '${suggestion}'?` : ""}`;
    });
}

export interface ValidationOptions {
  /** Let undeclared top-level arguments through (`sources[].allowUnknownArguments`). */
  allowUnknownArguments?: boolean;
}

/**
 * Check a call's arguments against the tool's input schema.
 * Returns the problems found, or an empty array when the arguments pass or the
 * schema cannot be used.
 */
export function validateArguments(
  toolName: string,
  schema: unknown,
  parameters: Record<string, unknown>,
  options: ValidationOptions = {},
): string[] {
  const unknown = options.allowUnknownArguments ? [] : unknownArguments(schema, parameters);

  const validate = validatorFor(toolName, schema);
  const schemaProblems = !validate || validate(parameters) ? [] : (validate.errors ?? []).map(describe);

  // A schema that sets additionalProperties: false reports the same key through Ajv;
  // the version with a suggestion is the one kept.
  const reported = new Set(unknown.map((line) => line.replace(/ - did you mean.*$/, "")));
  return [...new Set([...unknown, ...schemaProblems.filter((line) => !reported.has(line))])];
}
