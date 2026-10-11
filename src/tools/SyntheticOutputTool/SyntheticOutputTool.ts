import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { compileJsonSchema, formatSchemaIssues } from '../../services/schema/jsonSchemaEngine.js'
import { buildTool, type Tool, type ToolDef, type ToolInputJSONSchema } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './constants.js'

export { SYNTHETIC_OUTPUT_TOOL_NAME }

export function isSyntheticOutputToolEnabled({ isNonInteractiveSession }: { isNonInteractiveSession: boolean }): boolean {
  return isNonInteractiveSession
}

const inputSchema = lazySchema(() => z.looseObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.string().describe("The synthetic tool's echoed output text"))
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const SUCCESS_MESSAGE = 'Structured output provided successfully'
const DESCRIPTION = 'Returns structured output in the requested format.'
const PROMPT = `Use this tool to provide your final structured output. Call it exactly once, at the end of your response, with the output in the requested format.`
const HEADER_PAIRS = 3
const TELEMETRY_CHARS = 150

type Delivered = { data: Output; structured_output: unknown }

const delivered = (input: unknown): Delivered => ({ data: SUCCESS_MESSAGE, structured_output: input })

function headerOf(input: Record<string, unknown> | undefined): string {
  const fields = Object.entries(input ?? {})
  if (fields.length === 0) return ''
  if (fields.length > HEADER_PAIRS) return `${fields.length} fields: ${fields.slice(0, HEADER_PAIRS).map(([key]) => key).join(', ')}…`
  return fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
}

function schemaMismatch(issues: Parameters<typeof formatSchemaIssues>[0]): Error {
  const message = `Output does not match the required schema: ${formatSchemaIssues(issues)}`
  return new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(message, message.slice(0, TELEMETRY_CHARS))
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
    return delivered(input)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: output }
  },
  renderToolUseMessage: (input: Record<string, unknown> | undefined) => headerOf(input),
  renderToolUseRejectedMessage: () => React.createElement(Text, null, 'Structured output rejected'),
  renderToolUseErrorMessage: () => React.createElement(Text, { color: 'error' }, 'Structured output failed'),
  renderToolResultMessage: (output: Output) => React.createElement(Text, null, output),
  renderToolUseProgressMessage: () => null,
} satisfies ToolDef<InputSchema, Output>)

type SchemaBoundResult = { tool: Tool } | { error: string }

const schemaBoundCache = new WeakMap<object, SchemaBoundResult>()

function boundTo(jsonSchema: object): SchemaBoundResult {
  const compiled = compileJsonSchema(jsonSchema)
  if (!compiled.ok) return { error: compiled.error }
  const tool = {
    ...SyntheticOutputTool,
    inputJSONSchema: jsonSchema as ToolInputJSONSchema,
    async call(input: unknown): Promise<Delivered> {
      const issues = compiled.check(input)
      if (issues.length > 0) throw schemaMismatch(issues)
      return delivered(input)
    },
  } as unknown as Tool
  return { tool }
}

export function createSyntheticOutputTool(jsonSchema: object): SchemaBoundResult {
  const known = schemaBoundCache.get(jsonSchema)
  if (known) return known
  const bound = boundTo(jsonSchema)
  schemaBoundCache.set(jsonSchema, bound)
  return bound
}
