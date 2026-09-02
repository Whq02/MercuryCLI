// ============================================================================
//  primitives/execution — the Execution primitive contract.
//
//  ONE lifecycle vocabulary for everything that RUNS (Law 3): processes,
//  workers, managed runtimes, agents, model turns. Domains expose only the
//  states meaningful to them but must map explicitly onto this vocabulary —
//  the graph below is the single source of legal transitions, and the
//  execution plane enforces it mechanically.
//
//  Types + pure graph only — the registry lives in executionPlane.ts so this
//  module stays import-cycle-free for every domain adapter and proof.
// ============================================================================

import type { OwnerKey } from '../run/ownerKey.js'

export const EXECUTION_CONTRACT_VERSION = 1

/** The Law-3 canonical lifecycle vocabulary — the ONLY execution states. */
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

/** Terminal states — a record here is settled; further transitions refuse.
 *  New activity for the same logical thing is a NEW GENERATION, never a
 *  resurrection. */
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

/**
 * The legal transition graph. Design laws:
 *   · liveness moves forward: queued→starting→{ready,running}; ready↔running
 *     (readiness can be reached, lost, and re-reached); running↔waiting;
 *   · every live state can reach 'stopping' (stop is always requestable);
 *   · every live state can settle {failed, indeterminate} — crash and
 *     reconciliation honesty (Law 6) are never illegal;
 *   · 'succeeded' needs the work to have actually run (starting onward);
 *     'stopping' may settle 'succeeded' — a stop racing completion is real;
 *   · 'stopped' is reachable from any live state (external kill observed);
 *   · 'cancelled' is reachable from any live state (operator intent);
 *   · 'unavailable' settles only from queued/starting (the domain could not
 *     provide the runtime at all — a running thing is never 'unavailable');
 *   · terminals have NO outgoing edges.
 */
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

/** What kind of running thing an execution record describes. */
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

/** Whose lifetime bounds the execution (disposal semantics, Law 1). */
export type ExecutionLifecycle = 'owner' | 'session' | 'project'

export interface ExecutionSpec {
  version: typeof EXECUTION_CONTRACT_VERSION
  /** Stable, domain-chosen id — unique within (owner, kind); the SAME id
   *  across generations names the same logical thing. */
  id: string
  owner: OwnerKey
  kind: ExecutionKind
  label: string
  lifecycle: ExecutionLifecycle
  cwd?: string
  startedBy?: string
  /** Small typed domain payload — bounded, never dumps. */
  metadata?: Record<string, unknown>
}

/** The external identity a domain observed for the running thing — the
 *  plane records it, the DOMAIN owns liveness truth derived from it. */
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
  /** Monotonic per (owner, spec.id): restart/reset = generation + 1. */
  generation: number
  state: ExecutionState
  startedAt?: number
  updatedAt: number
  settledAt?: number
  externalIdentity?: ExecutionExternalIdentity
  outcome?: ExecutionOutcome
  /** Where the output lives (a mercury:// ref) — never inline output. */
  outputRef?: string
  /** Canonical evidence refs attached at settlement. */
  evidenceRefs: string[]
}

/** Ordered execution events (the plane's emission vocabulary). */
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
      /** Set when this transition was minted by reconciliation, not a live
       *  domain observation (Law 6 — recorded ≠ observed). */
      reconciled?: boolean
    }
  | {
      type: 'disposed'
      record: ExecutionRecord
    }

/** Typed refusal for an illegal edge — the plane throws THIS, never a bare
 *  Error, so domains and proofs can discriminate. */
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
