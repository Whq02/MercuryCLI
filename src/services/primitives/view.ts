
import type { ExecutionRecord, ExecutionState } from './execution.js'
import type { TransactionRecord, TransactionState } from './transaction.js'

export type CardState =
  | ExecutionState
  | 'expired'
  | 'busy'
  | 'absent'

export function executionCardState(state: ExecutionState): CardState {
  return state
}

export function transactionCardState(state: TransactionState): CardState {
  switch (state) {
    case 'created':
    case 'prepared':
    case 'proposed':
    case 'authorised':
      return 'queued'
    case 'applying':
    case 'checking':
      return 'running'
    case 'applied':
      return 'waiting'
    case 'verified':
      return 'ready'
    case 'settled':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'stale':
      return 'expired'
  }
}

export interface ExecutionView {
  id: string
  title: string
  state: CardState
  summary: string
  detailRefs: string[]
  startedAt?: number
  durationMs?: number
  generation: number
}

export interface TransactionView {
  id: string
  title: string
  state: CardState
  summary: string
  detailRefs: string[]
  failureDetail?: string
}

export function transactionView(record: TransactionRecord): TransactionView {
  return {
    id: record.id,
    title: record.kind,
    state: transactionCardState(record.state),
    summary:
      `${record.kind} · ${record.state}` +
      (record.resultRefs.length > 0 ? ` · ${record.resultRefs.length} result(s)` : ''),
    detailRefs: [
      ...(record.effectRef ? [record.effectRef] : []),
      ...record.evidenceRefs,
      ...record.resultRefs,
    ],
    ...(record.failure && {
      failureDetail: `${record.failure.code}: ${record.failure.message}`,
    }),
  }
}

export function executionView(record: ExecutionRecord): ExecutionView {
  const settled = record.settledAt
  const started = record.startedAt
  return {
    id: record.spec.id,
    title: record.spec.label,
    state: executionCardState(record.state),
    summary:
      `${record.spec.kind} · gen ${record.generation} · ${record.state}` +
      (record.outcome?.reason ? ` — ${record.outcome.reason}` : ''),
    detailRefs: [
      ...(record.outputRef ? [record.outputRef] : []),
      ...record.evidenceRefs,
    ],
    startedAt: started,
    durationMs: started !== undefined && settled !== undefined ? settled - started : undefined,
    generation: record.generation,
  }
}
