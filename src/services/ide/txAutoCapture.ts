import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { MERCURY_PROJECT_DIR } from '../../utils/projectConfig.js'
import type { ToolEffect } from '../../Tool.js'
import { receiptsFor } from '../changeTransaction/receipts.js'
import { isReceiptShaped } from '../changeTransaction/contracts.js'
import { subscribeToolTerminal, type ToolTerminalEvent } from '../run/effectObserver.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { subscribeEvidenceRecorded } from '../../utils/verification/verificationState.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  appendTransactionStep, ideLoopEnabled, noteStep, openTransaction, openTransactionIdFor,
  resolveRoot, type TxRecord, type TxStep, type TxStepKind, type TxStepOutcome,
} from './ideTransaction.js'

export function txAutoCaptureEnabled(): boolean {
  return ideLoopEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_TX_AUTOCAPTURE'))
}

export function classifyEffectStep(effect: ToolEffect): TxStepKind | null {
  if (effect.operation === 'git.stage') return null
  if (effect.operation === 'git.commit') return 'verify'
  if (isReceiptShaped(effect)) return 'apply'
  switch (effect.operation) {
    case 'test.run':
    case 'test.rerunFailed':
    case 'launch.test': return 'test'
    case 'launch.build': return 'build'
    case 'journey.run': return 'verify'
    case 'test.debug': return 'debug'
    default: return effect.operation.startsWith('debug.') ? 'debug' : null
  }
}

function outcomeOf(effect: ToolEffect, ok: boolean): TxStepOutcome {
  if (!ok || effect.outcome === 'failed') return 'failed'
  if (effect.outcome === 'indeterminate') return 'indeterminate'
  if (effect.outcome === 'no-change') return 'info'
  return 'ok'
}

const chains = new Map<string, Promise<unknown>>()
const journals = new Map<string, { record: TxRecord; paths: Set<string> }>()

export function inTxCaptureLane<T>(from: string, work: () => Promise<T>): Promise<T> {
  const root = resolveRoot(from)
  const previous = chains.get(root) ?? Promise.resolve()
  const turn = previous.then(work, work)
  chains.set(root, turn)
  const release = () => { if (chains.get(root) === turn) chains.delete(root) }
  void turn.then(release, release)
  return turn
}

function enqueue(root: string, work: () => Promise<void>): void {
  void inTxCaptureLane(root, work).catch(err => {
    logForDebugging(`txAutoCapture: ${err instanceof Error ? err.message : String(err)}`)
  })
}

export async function _drainTxAutoCaptureForTesting(): Promise<void> {
  while (chains.size) await Promise.all([...chains.values()])
}

export function txJournalFor(from: string): TxRecord | null {
  return journals.get(resolveRoot(from))?.record ?? null
}

export function clearTxJournal(from: string): void {
  journals.delete(resolveRoot(from))
}

export async function saveTxJournal(from: string, owner: OwnerKey): Promise<TxRecord | null> {
  const root = resolveRoot(from)
  const journal = journals.get(root)
  if (!journal) return null
  const record = await openTransaction({ owner, intent: journal.record.intent, from: root,
    steps: journal.record.steps, elided: journal.record.elided })
  journals.delete(root)
  return record
}

async function captureStep(root: string, owner: OwnerKey, step: TxStep, paths: string[] = []): Promise<void> {
  const id = openTransactionIdFor(root)
  if (id) {
    const noted = await noteStep({ id, owner, from: root, ...step })
    if (noted.state !== 'ok') logForDebugging(`txAutoCapture: note refused (${noted.reason})`)
    return
  }
  let journal = journals.get(root)
  if (!journal) {
    if (step.kind !== 'apply' || step.outcome !== 'ok') return
    journal = { record: { _v: 1, id: '', intent: '', owner, projectRoot: root, verdict: 'open',
      steps: [], unresolved: [], openedAt: step.at }, paths: new Set() }
    journals.set(root, journal)
  }
  if (!appendTransactionStep(journal.record, step)) return
  if (step.kind === 'apply' && step.outcome === 'ok') for (const path of paths) journal.paths.add(path)
  const files = [...journal.paths]
  const landed = journal.record.steps.filter(row => row.kind === 'apply' && row.outcome === 'ok').length
  journal.record.intent = `auto: ${landed} change(s) in ${files.length} file(s) — ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`.slice(0, 120)
}

function relativeInRoot(root: string, cwd: string, file: string): string | null {
  const local = relative(root, resolve(cwd, file))
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return null
  if (local.split(sep)[0] === MERCURY_PROJECT_DIR) return null
  return local || '.'
}

function onTerminal(event: ToolTerminalEvent): void {
  if (!txAutoCaptureEnabled() || !event.effect || !event.toolUseId) return
  const effect = event.effect
  const kind = classifyEffectStep(effect)
  if (!kind) return
  const root = resolveRoot(event.cwd)
  const receipt = [...receiptsFor(event.owner)].reverse().find(row => row.toolUseId === event.toolUseId)
  const targets = [...(receipt?.intent.targetPaths ?? []), ...effect.changedPaths]
  if (targets.length && !targets.some(file => relativeInRoot(root, event.cwd, file) !== null)) return
  const paths = [...new Set(effect.changedPaths.map(file => relativeInRoot(root, event.cwd, file)).filter((file): file is string => file !== null))]
  let outcome = outcomeOf(effect, event.ok)
  if (effect.operation === 'git.commit') outcome = 'info'
  if (kind === 'apply' && outcome === 'ok' && !paths.length) outcome = 'info'
  if (kind === 'apply' && outcome === 'ok' && !receipt) return
  const refs = kind === 'apply' && receipt ? [`mercury://receipt/${receipt.id}`] : []
  const listed = paths.length ? `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}` : '(no file written)'
  const summary = kind === 'apply'
    ? `[auto] ${effect.operation}: ${listed} — ${effect.evidence}`
    : `[auto] ${effect.operation}: ${effect.evidence}`
  const step: TxStep = { kind, outcome, refs, summary: summary.slice(0, 300), at: Date.now(), auto: { toolUseId: event.toolUseId } }
  enqueue(root, () => captureStep(root, event.owner, step, paths))
}

let evidenceSequence = 0
let installed = false
export function installTxAutoCapture(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(onTerminal)
  subscribeEvidenceRecorded((owner, record, cwd) => {
    if (!txAutoCaptureEnabled()) return
    const root = resolveRoot(cwd)
    const kind = record.scope === 'test' || record.scope === 'suite' ? 'test' : record.scope === 'build' ? 'build' : 'verify'
    const step: TxStep = {
      kind, outcome: record.ok ? 'ok' : 'failed', refs: [], at: record.ranAt,
      summary: `[auto] ${record.scope}: ${record.scope === 'read-back' ? record.coverage : record.command.slice(0, 160)} — ${record.ok ? 'green' : 'RED'}`.slice(0, 300),
      auto: { toolUseId: `evidence:${record.ranAt}:${record.seq}:${++evidenceSequence}` },
    }
    enqueue(root, () => captureStep(root, owner, step))
  })
}
installTxAutoCapture()
