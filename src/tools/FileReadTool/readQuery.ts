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
