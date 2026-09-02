import { compileJsonSchema, formatSchemaIssues } from '../../services/schema/jsonSchemaEngine.js'
import * as React from 'react'
import { z } from 'zod/v4'

import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef, type ToolInputJSONSchema } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './constants.js'

/**
 * The structured-output return tool for non-interactive runs, and its
 * JSON-Schema-bound factory. The name is transcript contract data; it lives
 * in ./constants.ts (a leaf) and is re-exported here for the tool's own
 * consumers.
 */
export { SYNTHETIC_OUTPUT_TOOL_NAME }

/** Enabled only in non-interactive sessions — the flag IS the answer. */
export function isSyntheticOutputToolEnabled({
  isNonInteractiveSession,
}: {
  isNonInteractiveSession: boolean
}): boolean {
  return isNonInteractiveSession
}

// The real schema is supplied dynamically (see createSyntheticOutputTool);
// the zod form is an open object that rejects nothing.
const inputSchema = lazySchema(() => z.looseObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.string().describe('The synthetic tool\'s echoed output text'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const SUCCESS_MESSAGE = 'Structured output provided successfully'

const DESCRIPTION = 'Returns structured output in the requested format.'
const PROMPT = `Use this tool to provide your final structured output. Call it exactly once, at the end of your response, with the output in the requested format.`

/** The header renders up to three `key: json` pairs; above three, a count + the first three names. */
function renderInputSummary(input: Record<string, unknown> | undefined): string {
  const keys = Object.keys(input ?? {})
  if (keys.length === 0) return ''
  if (keys.length <= 3) {
    return keys.map(key => `${key}: ${JSON.stringify(input![key])}`).join(', ')
  }
  return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}…`
}

export const SyntheticOutputTool = buildTool({
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  searchHint: 'return the final response as structured JSON output',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isMcp: false,
  // Creation is the gate (isSyntheticOutputToolEnabled); once created the
  // tool always reports itself enabled.
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isOpenWorld: () => false,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input) {
    return {
      data: SUCCESS_MESSAGE,
      structured_output: input,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output,
    }
  },
  renderToolUseMessage(input: Record<string, unknown> | undefined) {
    return renderInputSummary(input)
  },
  renderToolUseRejectedMessage() {
    return React.createElement(Text, null, 'Structured output rejected')
  },
  renderToolUseErrorMessage() {
    return React.createElement(Text, { color: 'error' }, 'Structured output failed')
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, null, output)
  },
  renderToolUseProgressMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, Output>)

type SchemaBoundResult = { tool: Tool } | { error: string }

// Workflow scripts call with the SAME schema object dozens of times per run
// and recompilation dominates otherwise; results — failures included — are
// cached by the identity of the schema object, and the cache never retains
// the schema (weak keying).
const schemaBoundCache = new WeakMap<object, SchemaBoundResult>()

/**
 * Bind the base tool to a JSON Schema: the schema becomes the declared input
 * schema and the execution body validates the input against it.
 */
export function createSyntheticOutputTool(jsonSchema: object): SchemaBoundResult {
  const cached = schemaBoundCache.get(jsonSchema)
  if (cached) return cached
  const built = buildSchemaBoundTool(jsonSchema)
  schemaBoundCache.set(jsonSchema, built)
  return built
}

function buildSchemaBoundTool(jsonSchema: object): SchemaBoundResult {
  // THE one validation engine (services/schema/jsonSchemaEngine, spec 03 C1)
  // compiles and judges; this module keeps only its own message contract.
  const compiled = compileJsonSchema(jsonSchema)
  if (!compiled.ok) return { error: compiled.error }
  const tool = {
    ...SyntheticOutputTool,
    inputJSONSchema: jsonSchema as ToolInputJSONSchema,
    async call(input: unknown) {
      const issues = compiled.check(input)
      if (issues.length > 0) {
        const message = `Output does not match the required schema: ${formatSchemaIssues(issues)}`
        throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
          message,
          message.slice(0, 150),
        )
      }
      return {
        data: SUCCESS_MESSAGE,
        structured_output: input,
      }
    },
  } as unknown as Tool
  return { tool }
}
