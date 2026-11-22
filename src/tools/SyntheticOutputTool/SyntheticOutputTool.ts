import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { compileJsonSchema, formatSchemaIssues } from '../../services/schema/jsonSchemaEngine.js'
import { buildTool, type Tool, type ToolDef, type ToolInputJSONSchema } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../constants/tools/syntheticOutput.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export { SYNTHETIC_OUTPUT_TOOL_NAME }

export function isSyntheticOutputToolEnabled({ isNonInteractiveSession }: { isNonInteractiveSession: boolean }): boolean {
  return isNonInteractiveSession
}
export type Output = Unbuilt

const SUCCESS_MESSAGE: Unbuilt = unbuilt('src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:23')
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

export const SyntheticOutputTool: Unbuilt = unbuilt('src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:45')

type SchemaBoundResult = { tool: Tool } | { error: string }

const schemaBoundCache = new WeakMap<object, SchemaBoundResult>()

export function createSyntheticOutputTool(jsonSchema: object): SchemaBoundResult {
  return notBuilt('src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:101')
}
