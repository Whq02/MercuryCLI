import type { ToolUseContext } from '../../Tool.js'
import type { Input } from './FileReadTool.js'
import type { FileReadingLimits } from './limits.js'
import type { ReadQueryTarget } from './readQueryTarget.js'

export interface ReadQueryRequest {
  target: ReadQueryTarget
  input: Input
  context: ToolUseContext
  limits: FileReadingLimits
  canUseTool?: unknown
  parentMessage?: unknown
}

export interface ReadQueryResult {
  content: string
  numLines: number
}

export async function readQuery(request: ReadQueryRequest): Promise<ReadQueryResult> {
  const { readJson } = await import('./readJson.js')
  return readJson(request)
}
