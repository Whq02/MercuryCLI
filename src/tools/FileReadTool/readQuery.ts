import type { ToolUseContext } from '../../Tool.js'
import type { Input } from './FileReadTool.js'
import type { FileReadingLimits } from './limits.js'
import type { ReadQueryTarget } from './readQueryTarget.js'
import { classifyReadTarget, readTargetsEnabled } from './readTarget.js'
import { mercuryRefsEnabled, parseMercuryRef } from '../../services/resources/contracts.js'

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
  readSource?: boolean
}

export async function readQuery(request: ReadQueryRequest): Promise<ReadQueryResult> {
  const kind = classifyReadTarget(request.target.source).kind
  if (kind === 'url' || (kind === 'resource' && (!readTargetsEnabled() || !mercuryRefsEnabled() || parseMercuryRef(request.target.source.trim()) === null))) return { content: '', numLines: 0, readSource: true }
  const { readJson } = await import('./readJson.js')
  return readJson(request)
}
