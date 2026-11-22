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
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/tools/SyntheticOutputTool/structuredOutputTool.ts:31')
}
