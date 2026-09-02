
import type { OwnerKey } from '../run/ownerKey.js'

export const EXECUTION_CONTRACT_VERSION = 1

export const EXECUTION_STATES = [
  'queued',
  'starting',
  'ready',
  'running',
  'waiting',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
  'cancelled',
  'unavailable',
  'indeterminate',
] as const

export type ExecutionState = (typeof EXECUTION_STATES)[number]

export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  'stopped',
  'succeeded',
  'failed',
  'cancelled',
  'unavailable',
  'indeterminate',
]

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(state)
}

const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  queued: ['starting', 'stopped', 'failed', 'cancelled', 'unavailable', 'indeterminate'],
  starting: [
    'ready',
    'running',
    'stopping',
    'stopped',
    'succeeded',
    'failed',
    'cancelled',
    'unavailable',
    'indeterminate',
  ],
  ready: ['running', 'waiting', 'stopping', 'stopped', 'succeeded', 'failed', 'cancelled', 'indeterminate'],
  running: ['ready', 'waiting', 'stopping', 'stopped', 'succeeded', 'failed', 'cancelled', 'indeterminate'],
  waiting: ['running', 'ready', 'stopping', 'stopped', 'succeeded', 'failed', 'cancelled', 'indeterminate'],
  stopping: ['stopped', 'succeeded', 'failed', 'cancelled', 'indeterminate'],
  stopped: [],
  succeeded: [],
  failed: [],
  cancelled: [],
  unavailable: [],
  indeterminate: [],
}

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function legalExecutionTransitions(from: ExecutionState): readonly ExecutionState[] {
  return TRANSITIONS[from]
}

export type ExecutionKind =
  | 'process'
  | 'service'
  | 'workshop-js'
  | 'workshop-python'
  | 'agent'
  | 'workflow-worker'
  | 'debug-adapter'
  | 'language-server'
  | 'background-job'
  | 'model-turn'
  | 'journey'
  | 'host-run-watch'

export type ExecutionLifecycle = 'owner' | 'session' | 'project'

export interface ExecutionSpec {
  version: typeof EXECUTION_CONTRACT_VERSION
  id: string
  owner: OwnerKey
  kind: ExecutionKind
  label: string
  lifecycle: ExecutionLifecycle
  cwd?: string
  startedBy?: string
  metadata?: Record<string, unknown>
}

export interface ExecutionExternalIdentity {
  pid?: number
  startToken?: string
  workerId?: string
  adapterId?: string
}

export interface ExecutionOutcome {
  code?: number
  signal?: string
  reason?: string
}

export interface ExecutionRecord {
  spec: ExecutionSpec
  generation: number
  state: ExecutionState
  startedAt?: number
  updatedAt: number
  settledAt?: number
  externalIdentity?: ExecutionExternalIdentity
  outcome?: ExecutionOutcome
  outputRef?: string
  evidenceRefs: string[]
}

export type ExecutionEvent =
  | {
      type: 'registered'
      record: ExecutionRecord
    }
  | {
      type: 'transition'
      record: ExecutionRecord
      from: ExecutionState
      to: ExecutionState
      reconciled?: boolean
    }
  | {
      type: 'disposed'
      record: ExecutionRecord
    }

export class ExecutionTransitionError extends Error {
  readonly from: ExecutionState
  readonly to: ExecutionState
  readonly executionId: string

  constructor(executionId: string, from: ExecutionState, to: ExecutionState) {
    super(
      `illegal execution transition '${from}' → '${to}' for '${executionId}'` +
        ` (legal: ${TRANSITIONS[from].join(', ') || 'none — terminal'})`,
    )
    this.name = 'ExecutionTransitionError'
    this.from = from
    this.to = to
    this.executionId = executionId
  }
}
