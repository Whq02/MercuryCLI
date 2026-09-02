// ============================================================================
//  primitives/transaction — the Transaction primitive contract (
//
//
//  ONE lifecycle for intended change. The wire truth stays the typed
//  ToolEffect + the exactly-once ChangeReceipt (services/changeTransaction/);
//  this contract ratifies the LIVE lifecycle around them so previewable and
//  multi-stage mutations speak one vocabulary. A transaction must never claim
//  applied without an observed effect, verified without an observed check,
//  no-change when paths changed, or stale without reread guidance where the
//  current version is known (Law 4).
//
//  Types + pure graph only — the registry lives in transactionPlane.ts
//
// ============================================================================

import type { OwnerKey } from '../run/ownerKey.js'

export const TRANSACTION_CONTRACT_VERSION = 1

export const TRANSACTION_STATES = [
  'created',
  'prepared',
  'proposed',
  'authorised',
  'applying',
  'applied',
  'checking',
  'verified',
  'settled',
  'failed',
  'cancelled',
  'stale',
] as const

export type TransactionState = (typeof TRANSACTION_STATES)[number]

export const TERMINAL_TRANSACTION_STATES: readonly TransactionState[] = [
  'settled',
  'failed',
  'cancelled',
  'stale',
]

export function isTerminalTransactionState(state: TransactionState): boolean {
  return TERMINAL_TRANSACTION_STATES.includes(state)
}

/**
 * The legal transition graph. Design laws:
 *   · the full previewable path is created → prepared → proposed →
 *     authorised → applying → applied → checking → verified → settled;
 *   · ordinary direct edits may SKIP forward (created → applying;
 *     applied → settled without a check) — skipping records honesty, it
 *     never fakes intermediate states;
 *   · staleness settles 'stale' only BEFORE apply (created/prepared/
 *     proposed/authorised) — once applying begins, a stale discovery is a
 *     failure, not a stale;
 *   · cancellation is legal before AND after apply (an applied-then-
 *     cancelled record keeps its effect refs — nothing is hidden);
 *   · 'checking' may fail (apply succeeded, check failed — the record
 *     stays honest about both);
 *   · terminals have NO outgoing edges.
 */
const TRANSITIONS: Record<TransactionState, readonly TransactionState[]> = {
  created: ['prepared', 'proposed', 'applying', 'failed', 'cancelled', 'stale'],
  prepared: ['proposed', 'authorised', 'applying', 'failed', 'cancelled', 'stale'],
  proposed: ['authorised', 'failed', 'cancelled', 'stale'],
  authorised: ['applying', 'failed', 'cancelled', 'stale'],
  applying: ['applied', 'failed', 'cancelled'],
  applied: ['checking', 'settled', 'failed', 'cancelled'],
  checking: ['verified', 'settled', 'failed', 'cancelled'],
  verified: ['settled', 'cancelled'],
  settled: [],
  failed: [],
  cancelled: [],
  stale: [],
}

export function canTransitionTransaction(from: TransactionState, to: TransactionState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function legalTransactionTransitions(from: TransactionState): readonly TransactionState[] {
  return TRANSITIONS[from]
}

export interface TransactionFailure {
  code: string
  message: string
  recoverable: boolean
}

/** The canonical transaction spine. Domain extensions (text edits, file
 *  writes, notebook edits, path renames, diagnostic fixes) carry their typed
 *  payloads beside it — never inside an untyped dictionary. */
export interface TransactionRecord {
  version: typeof TRANSACTION_CONTRACT_VERSION
  id: string
  owner: OwnerKey
  /** Domain kind ('file.edit', 'lsp.pathRename', …) — the effect/receipt
   *  operation vocabulary. */
  kind: string
  state: TransactionState
  createdAt: number
  updatedAt: number
  /** What the change is based on (mercury:// refs). */
  inputRefs: string[]
  /** The observed versions/anchors the intent was built against. */
  expectedVersions: string[]
  /** The execution this transaction ran under, when one exists. */
  executionRef?: string
  /** The observed effect (receipt ref) — REQUIRED for 'applied'+ (Law 4). */
  effectRef?: string
  evidenceRefs: string[]
  resultRefs: string[]
  failure?: TransactionFailure
}

/** Typed refusal for an illegal edge. */
export class TransactionTransitionError extends Error {
  readonly from: TransactionState
  readonly to: TransactionState
  readonly transactionId: string

  constructor(transactionId: string, from: TransactionState, to: TransactionState) {
    super(
      `illegal transaction transition '${from}' → '${to}' for '${transactionId}'` +
        ` (legal: ${TRANSITIONS[from].join(', ') || 'none — terminal'})`,
    )
    this.name = 'TransactionTransitionError'
    this.from = from
    this.to = to
    this.transactionId = transactionId
  }
}
