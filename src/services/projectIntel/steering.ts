
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

function astOn(name: 'AstSearch' | 'AstEdit', offered: OfferedTools): boolean {
  if (offered !== null) return offered.has(name)
  try {
    const { structurePolyglotEnabled } =
      require('../structure/contracts.js') as typeof import('../structure/contracts.js')
    const { resolveGrammarEngineDir } =
      require('../structure/grammarFacility.js') as typeof import('../structure/grammarFacility.js')
    return structurePolyglotEnabled() && resolveGrammarEngineDir().state === 'ok'
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
      'for a SYMBOL question (definition, references, callers, implementations) LspRead answers directly (goToDefinition · findReferences · incomingCalls) instead of text matching',
    )
  }
  if (astOn('AstSearch', offered)) {
    parts.push('for code by its shape, AstSearch matches the parse tree rather than the text')
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
  if (lspOn(offered)) parts.push('cross-file renames belong to LspRename (load it with ToolSearch)')
  if (astOn('AstEdit', offered))
    parts.push('one rewrite at every match of a code shape belongs to AstEdit (dry run, then apply)')
  if (parts.length === 0) return null
  return `Semantic shortcut: ${parts.join('; ')}.`
}
