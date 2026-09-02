// ============================================================================
//  projectIntel/steering — point-of-use semantic steering.
//
//  ONE capability-gated sentence appended to the LEXICAL tools' own
//  descriptions, pointing at the LIVE semantic owner at the exact moment of
//  tool choice — the measured journey defect is the model reaching for
//  Grep/Read when a semantic owner answers directly. The harness-map law
//  governs: an OFF capability is NEVER advertised (each fragment gates on
//  its own boot state; all off ⇒ null ⇒ the description is byte-identical
//  to the base text). No new tool, no new flag.
// ============================================================================

import { projectIntelEnabled } from './contracts.js'

function lspOn(): boolean {
  try {
    const { mercuryLspEnabled } =
      require('../lsp/mercuryLsp.js') as typeof import('../lsp/mercuryLsp.js')
    return mercuryLspEnabled()
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

/** For Grep/Glob: symbol questions have a direct semantic owner. */
export function searchSteeringLine(): string | null {
  // MERCURY_PROJECT_INTEL is the MASTER gate for every steering fragment —
  // the flag's `=0 byte-identical` promise covers these description bytes;
  // the per-owner gates below additionally keep an OFF owner unadvertised.
  if (!projectIntelEnabled()) return null
  const parts: string[] = []
  if (lspOn()) {
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

/** For Read: orientation has a cheaper summary than serial file-opening. */
export function readSteeringLine(): string | null {
  if (!projectIntelEnabled() || !refsOn()) return null
  return ' Orientation shortcut: before opening files one by one to learn a repo, Inspect mercury://project/current (topology · changes · checks · a task-scoped working set via ?child=context&q=<task>).'
}

/** For Edit: whole-symbol/cross-file changes have transactional owners. */
export function editSteeringLine(): string | null {
  if (!projectIntelEnabled()) return null // master gate — see searchSteeringLine
  const parts: string[] = []
  if (lspOn()) parts.push('cross-file renames belong to the LSP rename operation')
  if (structureOn())
    parts.push('repetitive structural JS/TS changes belong to the Structure tool (preview-first, stale-safe)')
  if (parts.length === 0) return null
  return `Semantic shortcut: ${parts.join('; ')}.`
}
