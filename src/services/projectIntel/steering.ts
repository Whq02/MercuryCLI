
import { projectIntelEnabled } from './contracts.js'
import { LSP_TOOL_NAME } from '../../tools/LSPTool/prompt.js'

export type OfferedTools = ReadonlySet<string> | null

function lspOn(offered: OfferedTools): boolean {
  if (offered !== null && !offered.has(LSP_TOOL_NAME)) return false
  try {
    const { mercuryLspEnabled } =
      require('../lsp/mercuryLsp.js') as typeof import('../lsp/mercuryLsp.js')
    const { isLspToolMounted } =
      require('../lsp/manager.js') as typeof import('../lsp/manager.js')
    return mercuryLspEnabled() && isLspToolMounted()
  } catch {
    return false
  }
}

function structureOn(): boolean {
  try {
    const { structureEnabled } =
      require('../structure/contracts.js') as typeof import('../structure/contracts.js')
    return structureEnabled()
  } catch {
    return false
  }
}

function refsOn(): boolean {
  try {
    const { mercuryRefsEnabled } =
      require('../resources/contracts.js') as typeof import('../resources/contracts.js')
    return mercuryRefsEnabled()
  } catch {
    return false
  }
}

export function searchSteeringLine(offered: OfferedTools = null): string | null {
  if (!projectIntelEnabled()) return null
  const parts: string[] = []
  if (lspOn(offered)) {
    parts.push(
      'for a SYMBOL question (definition, references, callers, implementations) the LSP tool answers directly (goToDefinition · findReferences · incomingCalls) instead of text matching',
    )
  }
  if (structureOn()) {
    parts.push('for typed AST queries over JS/TS the Structure tool beats regex')
  }
  if (parts.length === 0) return null
  return `  - Semantic shortcut: ${parts.join('; ')}.`
}

export function readSteeringLine(): string | null {
  if (!projectIntelEnabled() || !refsOn()) return null
  return ' Orientation shortcut: before opening files one by one to learn a repo, Inspect mercury://project/current (topology · changes · checks · a task-scoped working set via ?child=context&q=<task>).'
}

export function editSteeringLine(offered: OfferedTools = null): string | null {
  if (!projectIntelEnabled()) return null
  const parts: string[] = []
  if (lspOn(offered)) parts.push('cross-file renames belong to the LSP rename operation')
  if (structureOn())
    parts.push('repetitive structural JS/TS changes belong to the Structure tool (preview-first, stale-safe)')
  if (parts.length === 0) return null
  return `Semantic shortcut: ${parts.join('; ')}.`
}
