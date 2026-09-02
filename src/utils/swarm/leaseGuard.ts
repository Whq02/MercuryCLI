
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { logForDebugging } from '../debug.js'
import { normalizeLegacyToolName } from '../permissions/permissionRuleParser.js'
import { getTeamName, resolveCoordAgentId } from '../teammate.js'
import { getLeaseConflict } from './leaseGlob.js'

const GUARDED_TOOLS = new Set<string>([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

function extractFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const fp = input.file_path ?? input.notebook_path
  return typeof fp === 'string' && fp.length > 0 ? fp : null
}

export function getCurrentLeaseAgentId(): string {
  return resolveCoordAgentId()
}

export async function checkLeaseGuard(
  toolName: string,
  input: Record<string, unknown>,
  leaderTeamContext?: { teamName?: string },
): Promise<string | null> {
  const normalized = normalizeLegacyToolName(toolName)
  if (!GUARDED_TOOLS.has(normalized)) return null

  const team = getTeamName(
    leaderTeamContext as { teamName: string } | undefined,
  )
  if (!team) return null

  if (!input || typeof input !== 'object') return null
  const filePath = extractFilePath(normalized, input)
  if (!filePath) return null

  const agentId = getCurrentLeaseAgentId()

  let conflict
  try {
    conflict = await getLeaseConflict(team, agentId, filePath)
  } catch (e) {
    logForDebugging(`[leaseGuard] getLeaseConflict failed, allowing edit (lease coordination degraded): ${e}`, { level: 'warn' })
    return null
  }
  if (!conflict) return null

  return (
    `File lease conflict: ${filePath} is covered by a lease held by agent ` +
    `"${conflict.agentId}" (glob "${conflict.glob}"). Another agent is ` +
    `coordinating edits to this path. Pick a different file, or ask ` +
    `"${conflict.agentId}" to release its lease before editing here.`
  )
}
