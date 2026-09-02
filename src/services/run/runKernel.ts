// ============================================================================
//  runKernel — the React-free autonomous-run event model (Sol 5.6 frontier
//  sprint).
//
//  ONE source of truth for "what is this conversation trying to deliver and
//  where is it": an append-only RunEvent stream folded by a PURE reducer into
//  a RunSnapshot. Consumers: the stop/completion evaluator, the /run
//  inspector, the frame run capsule, resume reconciliation, and /health's
//  run-kernel probe. The coordinator (runCoordinator.ts) owns addressing,
//  persistence, and subscriptions; NOTHING in this module touches IO, React,
//  or ambient process state — proof scripts fold events directly.
//
//  Boundedness: the snapshot keeps folded counters plus BOUNDED tails
//  (recentEvents / recentEffects / changedPaths caps below) — never an
//  unbounded event file.
// ============================================================================

import type { ToolEffectOutcome } from '../../Tool.js'
import type { OwnerKey } from './ownerKey.js'
import {
  emptyProgressState,
  foldAttempt,
  foldEligibleProgress,
  foldStopDecision,
  foldTerminalProgress,
  type AttemptFingerprint,
  type RunProgressState,
} from './progressModel.js'

export const RUN_SCHEMA_VERSION = 1

/** Bounded-tail caps (folded counters carry totals beyond these). */
export const MAX_RECENT_EVENTS = 40
export const MAX_RECENT_EFFECTS = 24
export const MAX_CHANGED_PATHS = 200
export const MAX_DELIVERABLES = 100

export type RunLifecycle =
  | 'idle'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'completed'

export type DeliverableState = 'open' | 'in-progress' | 'done' | 'dropped'

export interface RunDeliverable {
  /** Stable id — the task id when observed from task state. */
  id: string
  title: string
  state: DeliverableState
}

export interface RunBlocker {
  description: string
  /** Who can resolve it. 'operator' terminates the continuation loop. */
  ownedBy: 'operator' | 'agent'
  resumeCondition: string
  at: number
}

export interface RunToolEffectRecord {
  toolName: string
  toolUseId: string | undefined
  operation: string
  outcome: ToolEffectOutcome
  changedPaths: string[]
  at: number
}

export type IdeFeedbackState = 'clean' | 'dirty' | 'pending' | 'unknown'

export type RunEvent =
  | {
      type: 'request-accepted'
      at: number
      objective: string
      rootMessageId: string | null
    }
  | { type: 'substantive'; at: number; reason: string }
  | { type: 'phase'; at: number; phase: string; reason: string }
  | {
      type: 'task-transition'
      at: number
      taskId: string
      title: string
      state: DeliverableState
    }
  | { type: 'tool-started'; at: number; toolName: string; toolUseId: string | undefined }
  | {
      /** one normalized attempt observed at tool settlement.
       *  Additive + optional: old sidecars fold without it. */
      type: 'attempt'
      at: number
      toolUseId: string | undefined
      fingerprint: AttemptFingerprint
    }
  | {
      type: 'tool-effected'
      at: number
      toolName: string
      toolUseId: string | undefined
      operation: string
      outcome: ToolEffectOutcome
      changedPaths: string[]
    }
  | {
      type: 'context-epoch'
      at: number
      epoch: number
      kind: 'auto-compact' | 'manual-compact' | 'micro-compact' | 'clear' | 'resume'
      reason: string
    }
  | { type: 'ide-feedback'; at: number; state: IdeFeedbackState; detail: string }
  | {
      type: 'evidence'
      at: number
      state: 'verified' | 'stale' | 'failed' | 'unverified'
      detail: string
    }
  | { type: 'continuation'; at: number; reason: string }
  | {
      type: 'stop-decision'
      at: number
      decision: string
      detail: string
    }
  | { type: 'next-action'; at: number; action: string }
  | { type: 'paused'; at: number; reason: string }
  | { type: 'resumed'; at: number; reason: string }
  | { type: 'blocked'; at: number; blocker: RunBlocker }
  | { type: 'interrupted'; at: number; reason: string }
  | { type: 'cancelled'; at: number; reason: string }
  | { type: 'failed'; at: number; reason: string }
  | { type: 'completed'; at: number; satisfied: string[] }
  | {
      /** A04: the session's model/transition truth, noted at
       *  the settlement seam — the durable cross-process channel the ACP
       *  `_mercury/run` projection reads (old/current/next visible on every
       *  surface). Additive + optional: old sidecars fold without it. */
      type: 'model-transition'
      at: number
      current: string | null
      pendingNext: string | null
      last?: {
        previous: string | null
        applied: string | null
        resolution: string
        boundary: string
        crossProvider: boolean
      }
      /** The resolved harness-profile identity at
       *  this boundary — present only while MERCURY_HARNESS_PROFILE is
       *  armed; absent events carry (and project) no harness claim. */
      harnessProfile?: {
        profileId: string
        profileDigest: string
        origin: string
        reasonCode: string
      }
    }

export interface RunSnapshot {
  schema: typeof RUN_SCHEMA_VERSION
  runId: string
  owner: OwnerKey
  rootMessageId: string | null
  objective: string
  startedAt: number
  updatedAt: number
  lifecycle: RunLifecycle
  /** True once the run created work items / mutated files / entered an
   *  implementation phase — pure Q&A turns stay lightweight (never persisted). */
  substantive: boolean
  phase: string
  phaseReason: string
  deliverables: RunDeliverable[]
  lastAction: string
  nextAction: string
  blocker: RunBlocker | null
  /** Exact paths from SUCCEEDED effects (bounded; totalChangedPaths counts all). */
  changedPaths: string[]
  totalChangedPaths: number
  recentEffects: RunToolEffectRecord[]
  /** tool_use ids started without a terminal observation — uncertainty markers. */
  pendingTools: Array<{ toolName: string; toolUseId: string | undefined; at: number }>
  /** Failed/indeterminate MUTATING effects not yet superseded by a green one. */
  unresolvedBadEffects: number
  verification: { state: 'verified' | 'stale' | 'failed' | 'unverified'; detail: string }
  contextEpoch: number
  lastContextTransition: { kind: string; reason: string; at: number } | null
  ideFeedback: { state: IdeFeedbackState; detail: string; at: number | null }
  continuationCount: number
  lastStopDecision: { decision: string; detail: string; at: number } | null
  /** the typed progress/attempt state (progress derived from
   *  REAL events only; attempts fingerprint-keyed so repeats are visible).
   *  Optional for pre-2.1 persisted sidecars; every kernel fold maintains it. */
  progress?: RunProgressState
  /** Bounded recent event tail + total counter. */
  recentEvents: RunEvent[]
  totalEvents: number
  /** The session's model/transition truth — optional: absent on
   *  legacy sidecars and on runs that never noted it. */
  modelState?: {
    current: string | null
    pendingNext: string | null
    last?: {
      previous: string | null
      applied: string | null
      resolution: string
      boundary: string
      crossProvider: boolean
    }
    /** The boundary's resolved harness-profile identity —
     *  present only while the flag is armed (the ACP `_mercury/run`
     *  projection inherits it; absent = no claim). */
    harnessProfile?: {
      profileId: string
      profileDigest: string
      origin: string
      reasonCode: string
    }
  }
}

export function emptyRunSnapshot(init: {
  runId: string
  owner: OwnerKey
  objective: string
  rootMessageId: string | null
  at: number
}): RunSnapshot {
  return {
    schema: RUN_SCHEMA_VERSION,
    runId: init.runId,
    owner: init.owner,
    rootMessageId: init.rootMessageId,
    objective: init.objective,
    startedAt: init.at,
    updatedAt: init.at,
    lifecycle: 'active',
    substantive: false,
    phase: 'intake',
    phaseReason: 'request accepted',
    deliverables: [],
    lastAction: '',
    nextAction: '',
    blocker: null,
    changedPaths: [],
    totalChangedPaths: 0,
    recentEffects: [],
    pendingTools: [],
    unresolvedBadEffects: 0,
    verification: { state: 'unverified', detail: 'no verification evidence yet' },
    contextEpoch: 0,
    lastContextTransition: null,
    ideFeedback: { state: 'unknown', detail: 'no IDE feedback yet', at: null },
    continuationCount: 0,
    lastStopDecision: null,
    progress: emptyProgressState(),
    recentEvents: [],
    totalEvents: 0,
  }
}

function pushBounded<T>(arr: T[], item: T, cap: number): T[] {
  const next = [...arr, item]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Is this effect a MUTATION attempt (vs a read/observation)? */
function isMutatingEffect(e: { outcome: ToolEffectOutcome; changedPaths: string[]; operation: string }): boolean {
  if (e.changedPaths.length > 0) return true
  return /\b(apply|write|edit|launch)\b/i.test(e.operation)
}

/**
 * The pure fold. Every event advances updatedAt and the bounded tails;
 * lifecycle transitions are explicit (never inferred from wording).
 */
export function reduceRunEvent(prev: RunSnapshot, event: RunEvent): RunSnapshot {
  // pre-2.1 sidecars hydrate without progress — every fold
  // re-mints so the field is present on any snapshot that folded once.
  const progress = prev.progress ?? emptyProgressState()
  const terminal = isTerminalLifecycle(prev.lifecycle)
  const base: RunSnapshot = {
    ...prev,
    updatedAt: event.at,
    recentEvents: pushBounded(prev.recentEvents, event, MAX_RECENT_EVENTS),
    totalEvents: prev.totalEvents + 1,
    progress,
  }
  switch (event.type) {
    case 'request-accepted':
      // A follow-up request on a live run refreshes the objective and
      // reactivates the loop (paused/blocked runs resume on operator input).
      return {
        ...base,
        objective: event.objective || prev.objective,
        rootMessageId: event.rootMessageId ?? prev.rootMessageId,
        lifecycle: 'active',
        blocker: null,
      }
    case 'substantive':
      return {
        ...base,
        substantive: true,
        phase: prev.phase === 'intake' ? 'implementation' : prev.phase,
        phaseReason: prev.phase === 'intake' ? event.reason : prev.phaseReason,
      }
    case 'phase':
      return { ...base, phase: event.phase, phaseReason: event.reason }
    case 'task-transition': {
      const existing = prev.deliverables.findIndex(d => d.id === event.taskId)
      let deliverables: RunDeliverable[]
      if (existing >= 0) {
        deliverables = prev.deliverables.map((d, i) =>
          i === existing ? { ...d, title: event.title || d.title, state: event.state } : d,
        )
      } else if (prev.deliverables.length < MAX_DELIVERABLES) {
        deliverables = [
          ...prev.deliverables,
          { id: event.taskId, title: event.title, state: event.state },
        ]
      } else {
        deliverables = prev.deliverables
      }
      return {
        ...base,
        deliverables,
        substantive: true,
        progress:
          event.state === 'done'
            ? foldEligibleProgress(progress, 'task-state', `${event.title || event.taskId} done`, event.at, terminal)
            : progress,
      }
    }
    case 'tool-started':
      return {
        ...base,
        lastAction: `${event.toolName} started`,
        pendingTools: pushBounded(
          prev.pendingTools,
          { toolName: event.toolName, toolUseId: event.toolUseId, at: event.at },
          MAX_RECENT_EFFECTS,
        ),
      }
    case 'attempt':
      return {
        ...base,
        progress: foldAttempt(progress, event.fingerprint, event.at, terminal),
      }
    case 'tool-effected': {
      const record: RunToolEffectRecord = {
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        operation: event.operation,
        outcome: event.outcome,
        changedPaths: event.changedPaths,
        at: event.at,
      }
      const succeeded = event.outcome === 'succeeded'
      const mutating = isMutatingEffect(event)
      const newPaths = succeeded
        ? event.changedPaths.filter(p => !prev.changedPaths.includes(p))
        : []
      return {
        ...base,
        lastAction: `${event.operation || event.toolName} ${event.outcome}`,
        pendingTools: prev.pendingTools.filter(p => p.toolUseId !== event.toolUseId),
        recentEffects: pushBounded(prev.recentEffects, record, MAX_RECENT_EFFECTS),
        changedPaths:
          newPaths.length > 0
            ? [...prev.changedPaths, ...newPaths].slice(-MAX_CHANGED_PATHS)
            : prev.changedPaths,
        totalChangedPaths: prev.totalChangedPaths + newPaths.length,
        substantive: prev.substantive || (mutating && succeeded && event.changedPaths.length > 0),
        unresolvedBadEffects:
          mutating && (event.outcome === 'failed' || event.outcome === 'indeterminate')
            ? prev.unresolvedBadEffects + 1
            : succeeded && mutating
              ? 0 // a green mutating effect supersedes earlier bad attempts
              : prev.unresolvedBadEffects,
        // Eligible progress = an artifact delta that PERSISTED (succeeded +
        // real changed paths) — reads/no-changes/failures never count (S1).
        progress:
          succeeded && event.changedPaths.length > 0
            ? foldEligibleProgress(
                progress,
                'artifact-delta',
                event.changedPaths.slice(0, 3).join(', '),
                event.at,
                terminal,
              )
            : progress,
      }
    }
    case 'context-epoch':
      return {
        ...base,
        contextEpoch: event.epoch,
        lastContextTransition: { kind: event.kind, reason: event.reason, at: event.at },
      }
    case 'ide-feedback':
      return { ...base, ideFeedback: { state: event.state, detail: event.detail, at: event.at } }
    case 'evidence':
      return {
        ...base,
        verification: { state: event.state, detail: event.detail },
        progress:
          event.state === 'verified'
            ? foldEligibleProgress(progress, 'verification', event.detail, event.at, terminal)
            : progress,
      }
    case 'continuation':
      return { ...base, continuationCount: prev.continuationCount + 1 }
    case 'stop-decision':
      return {
        ...base,
        lastStopDecision: { decision: event.decision, detail: event.detail, at: event.at },
        progress: foldStopDecision(progress, event.decision, terminal),
      }
    case 'next-action':
      return { ...base, nextAction: event.action }
    case 'model-transition':
      return {
        ...base,
        modelState: {
          current: event.current,
          pendingNext: event.pendingNext,
          // The receipt is transient at the noting seam (consume-and-clear):
          // an event without `last` keeps the previously-noted settlement.
          ...(event.last
            ? { last: event.last }
            : prev.modelState?.last
              ? { last: prev.modelState.last }
              : {}),
          // The harness identity mirrors the EVENT exactly —
          // an unarmed event drops it (state never claims a profile the
          // boundary didn't resolve).
          ...(event.harnessProfile ? { harnessProfile: event.harnessProfile } : {}),
        },
      }
    case 'paused':
      return { ...base, lifecycle: 'paused', phaseReason: event.reason }
    case 'resumed':
      return { ...base, lifecycle: 'active', phaseReason: event.reason, blocker: null }
    case 'blocked':
      return { ...base, lifecycle: 'blocked', blocker: event.blocker }
    case 'interrupted':
      return { ...base, lifecycle: 'interrupted', phaseReason: event.reason }
    case 'cancelled':
      return { ...base, lifecycle: 'cancelled', phaseReason: event.reason, progress: foldTerminalProgress(progress) }
    case 'failed':
      return { ...base, lifecycle: 'failed', phaseReason: event.reason, progress: foldTerminalProgress(progress) }
    case 'completed':
      return {
        ...base,
        lifecycle: 'completed',
        phase: 'done',
        phaseReason: event.satisfied.join('; ') || 'completed',
        nextAction: '',
        progress: foldTerminalProgress(progress),
      }
  }
}

/** Open (not done/dropped) deliverables — the completion evaluator's feed. */
export function openDeliverables(snapshot: RunSnapshot): RunDeliverable[] {
  return snapshot.deliverables.filter(d => d.state === 'open' || d.state === 'in-progress')
}

/** Terminal lifecycles — no continuation may fire after these. */
export function isTerminalLifecycle(l: RunLifecycle): boolean {
  return l === 'completed' || l === 'cancelled' || l === 'failed'
}
