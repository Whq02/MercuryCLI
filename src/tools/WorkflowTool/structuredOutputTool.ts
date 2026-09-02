// ============================================================================
// The schema-bound structured-output seam for workflow subagents.
//
// The BASE tool ('StructuredOutput') lets a headless or workflow subagent
// deliver its final answer through a tool call rather than prose; it lives in
// src/tools/SyntheticOutputTool/ and is not duplicated here. This module
// spreads that base object and layers on what the workflow agent hooks need:
// an identity-cached, per-schema variant — compiled and judged by THE one
// validation engine (services/schema/jsonSchemaEngine, spec 03 C1) — whose
// validation failure is a named, telemetry-safe error the model can act on.
//
// The agent hooks' dependency signature is exactly
// `(schema) => {tool} | {error}`, which is what the factory below provides.
// ============================================================================

import {
  compileJsonSchema,
  formatSchemaIssues,
  issueKeywords,
} from '../../services/schema/jsonSchemaEngine.js'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/constants.js'
import {
  SyntheticOutputTool,
  type Output,
} from '../SyntheticOutputTool/SyntheticOutputTool.js'

// The tool's wire name. Re-exported from the base tool's leaf constant so the
// two spellings cannot drift — a single source of truth for 'StructuredOutput'
// that this module reads without entering the tool module's import ring.
export const STRUCTURED_OUTPUT_TOOL_NAME = SYNTHETIC_OUTPUT_TOOL_NAME

/**
 * Raised when a schema-bound tool call fails validation. Two messages ride
 * on it: full failure detail for the model (each failing path with its
 * complaint — enough to correct and retry) and a stripped summary for
 * telemetry (validation keyword names only; instance data and paths are
 * user-owned and stay out). Built on the shared telemetry-safe error class,
 * with the summary re-exposed under the property name the workflow engine
 * expects.
 */
export class SchemaMismatchError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  readonly telemetrySafeMessage: string

  constructor(message: string, telemetrySafeMessage: string) {
    super(message, telemetrySafeMessage)
    this.name = 'SchemaMismatchError'
    // The base class stores the safe variant under its own field name; the
    // engine expects this accessor spelling as well.
    this.telemetrySafeMessage = telemetrySafeMessage
  }
}

type SchemaBoundResult = { tool: Tool; error?: undefined } | { error: string; tool?: undefined }

// Workflow scripts pass the SAME schema object reference across many agent()
// calls per run; Ajv compilation would otherwise dominate. Cache by object
// identity — successes AND failures — with weak keying so the cache never
// retains a schema.
const boundToolCache = new WeakMap<object, SchemaBoundResult>()

/**
 * A StructuredOutput tool bound to `schema`. The schema is declared on the
 * wire as the tool's input shape, and execution enforces it: conforming
 * input comes back as the structured output, non-conforming input raises
 * SchemaMismatchError and the model gets another attempt. A schema Ajv
 * itself rejects produces `{ error }` and no tool.
 */
export function getSchemaBoundStructuredOutputTool(schema: object): SchemaBoundResult {
  const cached = boundToolCache.get(schema)
  if (cached) return cached
  const built = bindSchema(schema)
  boundToolCache.set(schema, built)
  return built
}

function bindSchema(schema: object): SchemaBoundResult {
  // The ONE engine (spec 03 C1) compiles and judges; a schema the engine
  // refuses comes back as a teaching error the workflow surfaces verbatim.
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) return { error: compiled.error }

  const tool: Tool = {
    // Everything except the schema binding and the validating call() is
    // the base tool's: its name, its prompt text, its permission posture,
    // its renderers.
    ...SyntheticOutputTool,
    inputJSONSchema: schema as ToolInputJSONSchema,
    async call(input: unknown): Promise<{ data: string; structured_output: Output }> {
      const issues = compiled.check(input)
      if (issues.length > 0) {
        // What reaches telemetry is the keyword list alone — which
        // validation RULES fired, nothing about the data that fired them.
        throw new SchemaMismatchError(
          `Output does not match required schema: ${formatSchemaIssues(issues)}`,
          `${STRUCTURED_OUTPUT_TOOL_NAME} schema mismatch: ${issueKeywords(issues)}`,
        )
      }
      return {
        data: 'Structured output provided successfully',
        structured_output: input as Output,
      }
    },
  } as unknown as Tool

  return { tool }
}
