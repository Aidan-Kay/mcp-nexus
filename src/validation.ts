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

/**
 * Check a call's arguments against the tool's input schema.
 * Returns the problems found, or an empty array when the arguments pass or the
 * schema cannot be used.
 */
export function validateArguments(toolName: string, schema: unknown, parameters: Record<string, unknown>): string[] {
  const validate = validatorFor(toolName, schema);
  if (!validate || validate(parameters)) return [];
  return [...new Set((validate.errors ?? []).map(describe))];
}
