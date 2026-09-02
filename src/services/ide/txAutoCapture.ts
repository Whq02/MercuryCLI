// ============================================================================
//  ide/txAutoCapture — automatic closed-loop evidence capture.
//
//  While a coding transaction is OPEN in a project root, terminal effects
//  from the relevant owners auto-append their minimal typed step — the
//  model stops hand-noting every ordinary apply/test/build/debug/verify.
//  The design rides the ESTATE's exactly-once seams, adding none:
//
//    · ONE subscription on subscribeToolTerminal (the same chokepoint that
//      mints ChangeReceipts — importing receipts.js first guarantees the
//      receipt exists before this observer runs, so apply steps carry their
//      mercury://receipt ref from the REAL mint, never a fabrication);
//    · a DETERMINISTIC bounded operation→step registry (below) — unmapped
//      operations are never captured;
//    · dedup by (toolUseId, kind) PERSISTED on the step (`auto`), so a
//      resumed session can never double-record;
//    · capture is fully async and serialized per root (a queue chain) —
//      zero synchronous cost on tool completion; with no open transaction
//      the per-event cost is one in-memory map hit;
//    · completion law untouched: auto steps satisfy requirements only
//      because they carry real terminal effects and resolvable refs, and
//      `Transaction finish: completed` still refuses on any gap;
//    · the stabilize step auto-notes ONLY the honest vacuous case (no
//      diagnostics provider registered for the changed file) — with a live
//      LSP lane the barrier verdict stays with the existing LSP/manual flow.
//
//  Gate: MERCURY_TX_AUTOCAPTURE (default-ON), inert unless the IDE loop
//  itself (MERCURY_IDE_LOOP) is on and a transaction is open. `=0` restores
//  the fully-manual pre-S4 surface byte-identically.
//
//  Proof: scripts/edit-tools/prove-tx-autocapture.ts (suite scripts/edit-tools/).
// ============================================================================

import { basename } from 'node:path'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolEffect } from '../../Tool.js'
// receipts FIRST — subscriber order guarantees the receipt mint precedes us
import { receiptsFor } from '../changeTransaction/receipts.js'
import { subscribeToolTerminal, type ToolTerminalEvent } from '../run/effectObserver.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  ideLoopEnabled,
  noteStep,
  openTransactionIdFor,
  type TxStepKind,
  type TxStepOutcome,
} from './ideTransaction.js'

/** The S4 gate (composes with the IDE-loop owner; re-read live). */
export function txAutoCaptureEnabled(): boolean {
  return ideLoopEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_TX_AUTOCAPTURE'))
}

// ── the deterministic operation→step registry (bounded, exact) ─────────────
// Matched by exact operation, then by prefix. Unlisted operations are never
// captured — the registry IS the contract.
const EXACT: Record<string, TxStepKind> = {
  'file.edit': 'apply',
  'file.write': 'apply',
  'notebook.edit': 'apply',
  'structure.apply': 'apply',
  'file.astEdit': 'apply',
  'test.run': 'test',
  'test.rerunFailed': 'test',
  'test.debug': 'debug',
  'journey.run': 'verify',
  'git.commit': 'verify',
}
const PREFIX: Array<[string, TxStepKind]> = [
  ['lsp.rename', 'apply'],
  ['lsp.action', 'apply'],
  ['lsp.format', 'apply'],
  ['lsp.organizeImports', 'apply'],
  ['debug.', 'debug'],
  ['launch.build', 'build'],
  ['launch.test', 'test'],
]

export function classifyEffectStep(operation: string): TxStepKind | null {
  const exact = EXACT[operation]
  if (exact) return exact
  for (const [prefix, kind] of PREFIX) {
    if (operation.startsWith(prefix)) return kind
  }
  return null
}

function outcomeOf(effect: ToolEffect, ok: boolean): TxStepOutcome {
  if (!ok || effect.outcome === 'failed') return 'failed'
  if (effect.outcome === 'indeterminate') return 'indeterminate'
  if (effect.outcome === 'no-change') return 'info'
  return 'ok'
}

/** Does any registered diagnostics provider cover this file? (the honest
 *  vacuous-stabilize test — a live lane keeps the barrier verdict itself) */
function hasDiagnosticsProvider(filePath: string | undefined): boolean {
  if (!filePath) return false
  try {
    const { getLspServerManager } =
      require('../lsp/manager.js') as typeof import('../lsp/manager.js')
    const manager = getLspServerManager()
    if (!manager) return false
    return (manager as { hasServerForFile?: (p: string) => boolean }).hasServerForFile?.(filePath) ?? true
  } catch {
    return false
  }
}

// per-root serialization — captures never interleave a record's
// read-modify-write, and nothing here blocks the tool path
const chains = new Map<string, Promise<void>>()
function enqueue(root: string, work: () => Promise<void>): void {
  const prev = chains.get(root) ?? Promise.resolve()
  const next = prev.then(work).catch(err => {
    logForDebugging(`txAutoCapture: ${err instanceof Error ? err.message : String(err)}`)
  })
  chains.set(root, next)
}

/** Flush pending captures (proof seam — production never awaits this). */
export async function _drainTxAutoCaptureForTesting(): Promise<void> {
  await Promise.all([...chains.values()])
}

function onTerminal(event: ToolTerminalEvent): void {
  if (!txAutoCaptureEnabled()) return
  if (!event.effect || !event.toolUseId) return
  const kind = classifyEffectStep(event.effect.operation)
  if (kind === null) return
  const txId = openTransactionIdFor(event.cwd)
  if (!txId) return
  const effect = event.effect
  const toolUseId = event.toolUseId
  const ok = event.ok
  const owner = event.owner
  const cwd = event.cwd
  enqueue(cwd, async () => {
    // apply refs come from the REAL receipt minted one subscriber earlier
    const refs: string[] = []
    if (kind === 'apply' && ok) {
      const receipt = [...receiptsFor(owner)].reverse().find(r => r.toolUseId === toolUseId)
      if (receipt) refs.push(`mercury://receipt/${receipt.id}`)
    }
    const noted = await noteStep({
      id: txId,
      owner,
      kind,
      summary: `[auto] ${effect.operation}: ${effect.evidence}`.slice(0, 300),
      refs,
      outcome: outcomeOf(effect, ok),
      from: cwd,
      auto: { toolUseId },
    })
    if (noted.state !== 'ok') {
      logForDebugging(`txAutoCapture: note refused (${noted.reason}) — ${effect.operation}`)
      return
    }
    // the honest vacuous stabilize: a SUCCEEDED apply with NO diagnostics
    // provider for the changed file gets its barrier verdict recorded
    // truthfully (indeterminate/no-change applies earn no barrier)
    if (kind === 'apply' && ok && effect.outcome === 'succeeded' && effect.changedPaths.length > 0) {
      const file = effect.changedPaths[0]!
      if (!hasDiagnosticsProvider(file)) {
        await noteStep({
          id: txId,
          owner,
          kind: 'stabilize',
          summary: `[auto] no diagnostics provider for ${basename(file)} — stabilization vacuous`,
          outcome: 'ok',
          from: cwd,
          auto: { toolUseId: `${toolUseId}:stabilize` },
        })
      }
    }
  })
}

// Self-install at module scope — the receipts-ring idiom exactly. The gate
// is re-read per event; with the flag off or no open transaction the
// subscription is one map lookup per terminal event.
let installed = false
export function installTxAutoCapture(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(onTerminal)
}
installTxAutoCapture()
