
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

export interface TransactionRecord {
  version: typeof TRANSACTION_CONTRACT_VERSION
  id: string
  owner: OwnerKey
  kind: string
  state: TransactionState
  createdAt: number
  updatedAt: number
  inputRefs: string[]
  expectedVersions: string[]
  executionRef?: string
  effectRef?: string
  evidenceRefs: string[]
  resultRefs: string[]
  failure?: TransactionFailure
}

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
