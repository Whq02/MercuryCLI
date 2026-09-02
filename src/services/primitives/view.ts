// ============================================================================
//  primitives/view — the View primitive contract.
//
//  Views are PROJECTIONS: they render canonical records and typed
//  view-models; they never persist lifecycle truth (Law 5). The card
//  vocabulary IS the existing toolCardGrammar map — this module ratifies the
//  typed mappings from primitive states onto it so no component hand-rolls a
//  tone switch or a second "looks successful" path.
//
//  Pure + React-free: the view-model constructors live beside the components
// this contract owns only the state mappings and shapes.
// ============================================================================

import type { ExecutionRecord, ExecutionState } from './execution.js'
import type { TransactionRecord, TransactionState } from './transaction.js'

/** The card-grammar states primitive views emit (all mapped by cardTone —
 *  proved in scripts/primitives-kernel/). */
export type CardState =
  | ExecutionState
  | 'expired'
  | 'busy'
  | 'absent'

/** Execution states ARE card states — the grammar speaks Law 3 natively.
 *  Total identity mapping, ratified here so a future vocabulary change
 *  breaks THIS seam (and its proof), not a component. */
export function executionCardState(state: ExecutionState): CardState {
  return state
}

/**
 * The ONE transaction-state → card-state mapping (Law 5):
 *   · pre-apply staging reads as queued work;
 *   · applying/checking read as motion;
 *   · applied-awaiting-check reads as waiting (mutation landed, proof
 *     pending — NEVER painted succeeded);
 *   · verified reads ready (proof landed, settlement pending);
 *   · stale reads expired (staleness is retention/version honesty, not
 *     failure).
 */
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

/** The typed view-model one execution row/card renders from. Derived data
 *  only — no field here is a second source of lifecycle truth. */
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

/** The typed view-model one transaction row/card renders from. */
export interface TransactionView {
  id: string
  title: string
  state: CardState
  summary: string
  detailRefs: string[]
  failureDetail?: string
}

/** Construct the canonical view-model for a transaction record. Derived
 *  data only (Law 5) — a failed check after a successful mutation reads
 *  failed WITH its effect ref intact, never a second "looks successful"
 *  path. */
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

/** Construct the canonical view-model for an execution record. */
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
