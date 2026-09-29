
import { statSync } from 'node:fs'
import { getProjectRoot } from '../../bootstrap/state.js'
import { crewClaimConflict, crewClaimScopeConflict, crewClaimWords, resolveClaimHolder } from '../../services/crew/claims.js'
import { AST_EDIT_TOOL_NAME } from '../../tools/AstEditTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { relScope } from './leaseGlob.js'

const GUARDED_TOOLS = new Set<string>([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AST_EDIT_TOOL_NAME,
])

function extractFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const fp = input.file_path ?? input.notebook_path
  if (typeof fp === 'string' && fp.length > 0) return fp
  if (toolName !== AST_EDIT_TOOL_NAME) return null
  return typeof input.path === 'string' && input.path.length > 0 ? input.path : getCwd()
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function spoken(filePath: string): string {
  const rel = relScope(filePath, getProjectRoot())
  return rel === '' || rel === '..' || rel.startsWith('../') ? filePath : rel
}

export function getCurrentLeaseAgentId(): string {
  return resolveClaimHolder().name
}

export async function checkLeaseGuard(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  const normalized = toolName
  if (!GUARDED_TOOLS.has(normalized)) return null

  if (!input || typeof input !== 'object') return null
  const filePath = extractFilePath(normalized, input)
  if (!filePath) return null

  const holder = resolveClaimHolder()

  try {
    if (normalized === AST_EDIT_TOOL_NAME && isFolder(filePath)) {
      const scoped = await crewClaimScopeConflict(filePath, holder)
      return scoped ? crewClaimWords(scoped.glob, scoped.holder) : null
    }
    const conflict = await crewClaimConflict(filePath, holder)
    return conflict ? crewClaimWords(spoken(filePath), conflict.holder) : null
  } catch (e) {
    logForDebugging(`[leaseGuard] the claim read failed, allowing edit (claim coordination degraded): ${e}`, { level: 'warn' })
    return null
  }
}
