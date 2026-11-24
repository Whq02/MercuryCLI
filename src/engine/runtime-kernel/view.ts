import type { ExecutionState } from '../execution-plane/execution.js'
import type { TransactionState } from './transaction.js'

type CardState =
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
