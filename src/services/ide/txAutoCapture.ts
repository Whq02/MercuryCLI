
import { basename } from 'node:path'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolEffect } from '../../Tool.js'
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

export function txAutoCaptureEnabled(): boolean {
  return ideLoopEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_TX_AUTOCAPTURE'))
}

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

const chains = new Map<string, Promise<void>>()
function enqueue(root: string, work: () => Promise<void>): void {
  const prev = chains.get(root) ?? Promise.resolve()
  const next = prev.then(work).catch(err => {
    logForDebugging(`txAutoCapture: ${err instanceof Error ? err.message : String(err)}`)
  })
  chains.set(root, next)
}

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

let installed = false
export function installTxAutoCapture(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(onTerminal)
}
installTxAutoCapture()
