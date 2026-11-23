import type { ListToolsResult, Tool as McpSdkTool } from '../../mcp-shapes/sdk.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { logMCPDebug } from '../../../platform/logs/errorLog.js'
import type { ConnectedMCPServer } from '../../mcp-shapes/mcpServerRecords.js'
import { connectTimeoutMs } from './limits.js'

const TOOLS_MAX_PAGES = 50
const TOOLS_MAX_PER_SERVER = 1000

export async function listAllTools(client: ConnectedMCPServer): Promise<McpSdkTool[]> {
  const accumulated: McpSdkTool[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < TOOLS_MAX_PAGES; page++) {
    let result: ListToolsResult
    try {
      result = await client.client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        { timeout: connectTimeoutMs() },
      )
    } catch (err) {
      if (page === 0) throw err
      logMCPDebug(client.name, `tools/list page ${page} failed; keeping ${accumulated.length} tools: ${errorMessage(err)}`)
      break
    }
    accumulated.push(...(result.tools ?? []))
    if (accumulated.length >= TOOLS_MAX_PER_SERVER) {
      logMCPDebug(client.name, `tool cap ${TOOLS_MAX_PER_SERVER} reached; truncating`)
      accumulated.length = TOOLS_MAX_PER_SERVER
      break
    }
    const next = result.nextCursor
    if (!next) break
    if (seenCursors.has(next)) {
      logMCPDebug(client.name, 'repeated tools/list cursor; stopping pagination')
      break
    }
    seenCursors.add(next)
    cursor = next
  }
  return accumulated
}
