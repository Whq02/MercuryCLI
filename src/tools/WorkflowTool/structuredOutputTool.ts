
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
  if (cached) return cached
  const built = bindSchema(schema)
  boundToolCache.set(schema, built)
  return built
}

function bindSchema(schema: object): SchemaBoundResult {
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) return { error: compiled.error }

  const tool: Tool = {
    ...SyntheticOutputTool,
    inputJSONSchema: schema as ToolInputJSONSchema,
    async call(input: unknown): Promise<{ data: string; structured_output: Output }> {
      const issues = compiled.check(input)
      if (issues.length > 0) {
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
