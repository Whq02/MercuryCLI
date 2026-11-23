import {
  compileJsonSchema,
  formatSchemaIssues,
  issueKeywords,
} from '../../services/schema/jsonSchemaEngine.js'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../constants/tools/syntheticOutput.js'
import {
  SyntheticOutputTool,
  type Output,
} from './SyntheticOutputTool.js'

export const STRUCTURED_OUTPUT_TOOL_NAME = SYNTHETIC_OUTPUT_TOOL_NAME

export class SchemaMismatchError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  readonly telemetrySafeMessage: string

  constructor(message: string, telemetrySafeMessage: string) {
    super(message, telemetrySafeMessage)
    this.name = 'SchemaMismatchError'
    this.telemetrySafeMessage = telemetrySafeMessage
  }
}

type SchemaBoundResult = { tool: Tool; error?: undefined } | { error: string; tool?: undefined }

const boundToolCache = new WeakMap<object, SchemaBoundResult>()

export function getSchemaBoundStructuredOutputTool(schema: object): SchemaBoundResult {
  const cached = boundToolCache.get(schema)
  if (cached !== undefined) return cached
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) {
    const failed: SchemaBoundResult = { error: compiled.error }
    boundToolCache.set(schema, failed)
    return failed
  }
  const tool: Tool = {
    ...SyntheticOutputTool,
    inputJSONSchema: schema as ToolInputJSONSchema,
    async call(input) {
      const issues = compiled.check(input)
      if (issues.length > 0) {
        throw new SchemaMismatchError(
          `Output does not match required schema: ${formatSchemaIssues(issues)}`,
          `${STRUCTURED_OUTPUT_TOOL_NAME} schema mismatch: ${issueKeywords(issues)}`,
        )
      }
      const data: Output = 'Structured output provided successfully'
      return { data, structured_output: input }
    },
  }
  const result: SchemaBoundResult = { tool }
  boundToolCache.set(schema, result)
  return result
}
