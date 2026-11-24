import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../screen/themedRenderer.js'
import { compileJsonSchema, formatSchemaIssues, issueKeywords } from '../../platform/json-schema/jsonSchemaEngine.js'
import { buildTool, type Tool, type ToolDef, type ToolInputJSONSchema } from '../kit/tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../platform/errors/errors.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../kit/names/structuredOutput.js'

export { STRUCTURED_OUTPUT_TOOL_NAME }

export function isStructuredOutputToolEnabled({ isNonInteractiveSession }: { isNonInteractiveSession: boolean }): boolean {
  return isNonInteractiveSession
}

const inputSchema = lazySchema(() => z.looseObject({}))
const outputSchema = lazySchema(() => z.string().describe("The synthetic tool's echoed output text"))
type InputSchema = ReturnType<typeof inputSchema>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const SUCCESS_MESSAGE: Output = 'Structured output provided successfully'
const PROMPT = `Use this tool to provide your final structured output. Call it exactly once, at the end of your response, with the output in the requested format.`
const HEADER_PAIRS = 3

type Delivered = { data: Output; structured_output: unknown }

const delivered = (input: unknown): Delivered => ({ data: SUCCESS_MESSAGE, structured_output: input })

function headerOf(input: Record<string, unknown> | undefined): string {
  const fields = Object.entries(input ?? {})
  if (fields.length === 0) return ''
  if (fields.length > HEADER_PAIRS) return `${fields.length} fields: ${fields.slice(0, HEADER_PAIRS).map(([key]) => key).join(', ')}…`
  return fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
}

export const StructuredOutputTool = buildTool({
  name: STRUCTURED_OUTPUT_TOOL_NAME,
  searchHint: 'return the final response as structured JSON output',
  maxResultSizeChars: 100_000,
  isMcp: false,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isOpenWorld: () => false,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return 'Returns structured output in the requested format.'
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
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output,
    }
  },
  renderToolUseMessage(input) {
    return headerOf(input)
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolUseRejectedMessage() {
    return React.createElement(Text, null, 'Structured output rejected')
  },
  renderToolUseErrorMessage() {
    return React.createElement(Text, { color: 'error' }, 'Structured output failed')
  },
  renderToolResultMessage(output) {
    return React.createElement(Text, null, output)
  },
} satisfies ToolDef<InputSchema, Output>)

export class SchemaMismatchError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  readonly telemetrySafeMessage: string

  constructor(message: string, telemetrySafeMessage: string) {
    super(message, telemetrySafeMessage)
    this.name = 'SchemaMismatchError'
    this.telemetrySafeMessage = telemetrySafeMessage
  }
}

type SchemaBoundResult = { ok: true; tool: Tool } | { ok: false; error: string }

const schemaBoundCache = new WeakMap<object, SchemaBoundResult>()

export function getSchemaBoundStructuredOutputTool(jsonSchema: object): SchemaBoundResult {
  const cached = schemaBoundCache.get(jsonSchema)
  if (cached !== undefined) return cached
  const compiled = compileJsonSchema(jsonSchema)
  if (!compiled.ok) {
    const failed: SchemaBoundResult = { ok: false, error: compiled.error }
    schemaBoundCache.set(jsonSchema, failed)
    return failed
  }
  const tool: Tool = {
    ...StructuredOutputTool,
    inputJSONSchema: jsonSchema as ToolInputJSONSchema,
    async call(input) {
      const issues = compiled.check(input)
      if (issues.length > 0) {
        throw new SchemaMismatchError(
          `Output does not match the required schema: ${formatSchemaIssues(issues)}`,
          `${STRUCTURED_OUTPUT_TOOL_NAME} schema mismatch: ${issueKeywords(issues)}`,
        )
      }
      return delivered(input)
    },
  }
  const result: SchemaBoundResult = { ok: true, tool }
  schemaBoundCache.set(jsonSchema, result)
  return result
}
