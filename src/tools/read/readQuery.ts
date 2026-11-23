import type { CanUseToolFn, ToolUseContext } from '../kit/tool.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import type { Input } from './ReadTool.js'
import type { FileReadingLimits } from './call/fileReadLimits.js'
import type { ReadQueryTarget } from './readQueryTarget.js'
import { classifyReadTarget, readTargetsEnabled } from './readTarget.js'
import { mercuryRefsEnabled, parseMercuryRef } from '../../integrations/resources/contracts.js'

export interface ReadQueryRequest {
  target: ReadQueryTarget
  input: Input
  context: ToolUseContext
  limits: FileReadingLimits
  canUseTool?: CanUseToolFn
  parentMessage?: AssistantMessage
}

export interface ReadQueryResult {
  content: string
  numLines: number
  readSource?: boolean
}

export async function readQuery(request: ReadQueryRequest): Promise<ReadQueryResult> {
  const kind = classifyReadTarget(request.target.source).kind
  if (kind === 'url' || (kind === 'resource' && (!readTargetsEnabled() || !mercuryRefsEnabled() || parseMercuryRef(request.target.source.trim()) === null))) return { content: '', numLines: 0, readSource: true }
  if (request.target.parameters.view === 'profile') {
    const { readProfiles } = await import('./readProfiles.js')
    return (await readProfiles(request))!
  }
  const parameters = request.target.parameters
  if (parameters.sql !== undefined || parameters.table !== undefined || (parameters.q === undefined && parameters.query === undefined && /\.(?:sqlite3?|db)(?::[^\r\n]+)?$/i.test(request.target.source))) {
    const { sqliteQuery } = await import('./sqliteQuery.js')
    return sqliteQuery(request)
  }
  const { readJson } = await import('./readJson.js')
  return readJson(request)
}
