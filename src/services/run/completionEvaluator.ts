
import {
  isTerminalLifecycle,
  openDeliverables,
  type RunSnapshot,
} from './runKernel.js'
import { actionFingerprint } from './progressModel.js'
import { buildHandoffReport, renderHandoffReport } from './cycleLease.js'

export type StopDecision =
  | { kind: 'complete'; satisfied: string[] }
  | {
      kind: 'continue'
      nextAction: string
      reason: string
      evidenceDemand?: boolean
    }
  | {
      kind: 'blocked'
      blocker: string
      ownedBy: 'operator'
      resumeCondition: string
    }
  | { kind: 'pause'; cause: string }
  | { kind: 'cancel'; cause: string }
  | { kind: 'fail'; cause: string }
  | { kind: 'budget-exhausted'; unfinished: string[] }
  | {
      kind: 'handoff'
      cause: string
      unfinished: string[]
      strategiesTried: number
      report: string
    }

export interface StopEvaluationInput {
  snapshot: RunSnapshot | null
  wordingUnfinished: boolean
  continuationsThisTurn: number
  maxContinuationsPerTurn: number
  aborted: boolean
  apiError: boolean
  verification: {
    state: 'verified' | 'stale' | 'failed' | 'unverified'
    mutationsSinceEvidence: number
    workspaceVerifiable?: boolean
    priorEvidenceDemands?: number
  } | null
  pendingIdeFeedback: boolean
  surface?: 'interactive' | 'print' | 'sdk' | 'worker' | 'workflow' | 'external'
  terminalPolicy?: 'operator-led' | 'one-shot' | 'client-led' | 'mission-led'
  strategyRepeated?: boolean
  preconditionChanged?: boolean
  revision?: {
    runRevision: number
    effectRevision: number
    evidenceRevision: number
    externalRevision: number
  }
  priorAdmission?: {
    revision: {
      runRevision: number
      effectRevision: number
      evidenceRevision: number
      externalRevision: number
    }
    nextActionFingerprint: string
  } | null
}

const MAX_EVIDENCE_DEMANDS = 2

function satisfiedConditions(input: StopEvaluationInput): string[] {
  const s: string[] = []
  const snap = input.snapshot
  if (snap) {
    const open = openDeliverables(snap)
    s.push(
      open.length === 0
        ? snap.deliverables.length > 0
          ? `all ${snap.deliverables.length} deliverable(s) closed`
          : 'no open deliverables'
        : `UNSATISFIED: ${open.length} open`,
    )
    if (snap.unresolvedBadEffects === 0) s.push('no failed/indeterminate mutating effects')
    if (snap.pendingTools.length === 0) s.push('no tools in flight')
  }
  if (input.verification) {
    if (input.verification.mutationsSinceEvidence === 0) {
      s.push(`evidence ${input.verification.state}`)
    }
  }
  if (!input.pendingIdeFeedback) s.push('IDE feedback current')
  return s
}

export function evaluateStop(input: StopEvaluationInput): StopDecision {
  if (input.aborted) return { kind: 'cancel', cause: 'operator interrupt (abort signal)' }
  if (input.apiError) return { kind: 'fail', cause: 'API error terminated the turn' }
  {
    const snap = input.snapshot
    if (
      snap &&
      snap.substantive &&
      !isTerminalLifecycle(snap.lifecycle) &&
      snap.blocker &&
      snap.blocker.ownedBy === 'operator'
    ) {
      return {
        kind: 'blocked',
        blocker: snap.blocker.description,
        ownedBy: 'operator',
        resumeCondition: snap.blocker.resumeCondition,
      }
    }
  }
  if (input.continuationsThisTurn >= input.maxContinuationsPerTurn) {
    const freshProgress = (input.snapshot?.progress?.progressSinceDecision ?? 0) > 0
    if (!freshProgress) {
      const unfinished: string[] = []
      const snap = input.snapshot
      if (snap) {
        for (const d of openDeliverables(snap)) unfinished.push(d.title || d.id)
        if (snap.unresolvedBadEffects > 0) {
          unfinished.push(`${snap.unresolvedBadEffects} failed/indeterminate effect(s)`)
        }
      }
      if (input.verification && input.verification.mutationsSinceEvidence > 0) {
        unfinished.push(
          `${input.verification.mutationsSinceEvidence} unverified mutation(s)`,
        )
      }
      return { kind: 'budget-exhausted', unfinished }
    }
  }

  const snap = input.snapshot
  if (!snap || !snap.substantive) {
    if (input.wordingUnfinished) {
      return {
        kind: 'continue',
        nextAction: 'do the promised/planned work now with tool calls',
        reason: 'the last paragraph is a promise, plan, or self-answerable question',
      }
    }
    return { kind: 'complete', satisfied: ['no active implementation run; tail is a finished status'] }
  }

  if (isTerminalLifecycle(snap.lifecycle)) {
    return { kind: 'complete', satisfied: [`run already ${snap.lifecycle}`] }
  }

  if (snap.lifecycle === 'paused') {
    return { kind: 'pause', cause: snap.phaseReason || 'run paused' }
  }

  const oneShot =
    input.terminalPolicy === 'one-shot' ||
    (input.terminalPolicy === undefined && (input.surface === 'print' || input.surface === 'worker'))
  if (oneShot && snap.pendingTools.length === 0 && snap.unresolvedBadEffects === 0) {
    return {
      kind: 'complete',
      satisfied: [
        ...satisfiedConditions(input),
        'one-shot surface: requested effects settled; no further verification requested',
      ],
    }
  }

  const progressState = snap.progress
  const noNewProgress = (progressState?.progressSinceDecision ?? 0) === 0
  const strategyRepeated =
    input.strategyRepeated === true ||
    progressState?.phase === 'replan-required' ||
    progressState?.phase === 'handoff-required'
  const rearmed = input.preconditionChanged === true
  const escalate = (candidate: StopDecision): StopDecision => {
    if (candidate.kind !== 'continue' || candidate.evidenceDemand === true) return candidate
    if (input.revision && input.priorAdmission && !rearmed) {
      const r = input.revision
      const p = input.priorAdmission.revision
      const sameTuple =
        r.runRevision === p.runRevision &&
        r.effectRevision === p.effectRevision &&
        r.evidenceRevision === p.evidenceRevision &&
        r.externalRevision === p.externalRevision
      const sameAction =
        actionFingerprint(candidate.nextAction) === input.priorAdmission.nextActionFingerprint
      if (sameTuple && sameAction) {
        return {
          kind: 'handoff',
          cause:
            'the same revision tuple and next action may not open another provider call (A04-A06 admission law)',
          unfinished: openDeliverables(snap).map(d => d.title || d.id),
          strategiesTried: progressState?.attempts.length ?? 0,
          report: renderHandoffReport(
            buildHandoffReport(snap, 'A04-A06 admission refusal: unchanged revision tuple + identical next action'),
          ),
        }
      }
    }
    if (!noNewProgress || rearmed) return candidate
    const attempts = input.continuationsThisTurn
    if (attempts >= 2 || (strategyRepeated && attempts >= 1)) {
      const unfinished = openDeliverables(snap).map(d => d.title || d.id)
      if (snap.unresolvedBadEffects > 0) {
        unfinished.push(`${snap.unresolvedBadEffects} failed/indeterminate effect(s)`)
      }
      return {
        kind: 'handoff',
        cause: strategyRepeated
          ? 'the same strategy repeated with no new evidence (the one replan is spent)'
          : 'no eligible progress across the allowed continuations — stagnation settles with a handoff',
        unfinished,
        strategiesTried: progressState?.attempts.length ?? 0,
        report: renderHandoffReport(
          buildHandoffReport(
            snap,
            strategyRepeated ? 'strategy repetition with no new evidence' : 'stagnation across allowed continuations',
          ),
        ),
      }
    }
    if (attempts >= 1 || strategyRepeated) {
      return {
        ...candidate,
        nextAction: `REPLAN: the prior approach earned no new evidence — change strategy (different tool family, target, or decomposition), then: ${candidate.nextAction}`,
        reason: `${candidate.reason} — replan directive (no eligible progress since the last decision)`,
      }
    }
    return candidate
  }

  const open = openDeliverables(snap)
  if (open.length > 0) {
    const next = open[0]!
    return escalate({
      kind: 'continue',
      nextAction: `work the open deliverable: ${next.title || next.id}`,
      reason: `${open.length} deliverable(s) still open`,
    })
  }
  if (snap.unresolvedBadEffects > 0) {
    return escalate({
      kind: 'continue',
      nextAction: 'inspect the failed/indeterminate operation and reconcile its real state',
      reason: `${snap.unresolvedBadEffects} mutating effect(s) failed or ended indeterminate`,
    })
  }
  if (snap.pendingTools.length > 0) {
    return escalate({
      kind: 'continue',
      nextAction: `resolve the in-flight tool call (${snap.pendingTools[0]!.toolName})`,
      reason: 'a tool started without a terminal effect',
    })
  }
  if (input.verification && input.verification.mutationsSinceEvidence > 0) {
    const v = input.verification
    const demands = v.priorEvidenceDemands ?? 0
    if (demands >= MAX_EVIDENCE_DEMANDS) {
      return {
        kind: 'complete',
        satisfied: [
          ...satisfiedConditions(input),
          `UNSETTLED: ${v.mutationsSinceEvidence} mutation(s) without evidence after ${demands} demand(s) — recorded, not blocking`,
        ],
      }
    }
    if (v.workspaceVerifiable === false) {
      return {
        kind: 'continue',
        nextAction:
          'read each changed file back (Read) to confirm the written content — this workspace has no verification machinery, so read-back is the evidence',
        reason: `${v.mutationsSinceEvidence} mutation(s) with no gate to run here`,
        evidenceDemand: true,
      }
    }
    return {
      kind: 'continue',
      nextAction: 'run the smallest real verification covering the changed behavior',
      reason: `${v.mutationsSinceEvidence} mutation(s) after the last evidence`,
      evidenceDemand: true,
    }
  }
  if (input.verification && input.verification.state === 'failed') {
    const demands = input.verification.priorEvidenceDemands ?? 0
    if (demands >= MAX_EVIDENCE_DEMANDS) {
      return {
        kind: 'complete',
        satisfied: [
          ...satisfiedConditions(input),
          `UNSETTLED: the newest verification evidence is RED after ${demands} demand(s) — recorded, not blocking`,
        ],
      }
    }
    return {
      kind: 'continue',
      nextAction: 'fix the failing verification and re-run it',
      reason: 'the newest verification evidence FAILED',
      evidenceDemand: true,
    }
  }
  if (input.pendingIdeFeedback) {
    return escalate({
      kind: 'continue',
      nextAction: 'drain the pending post-edit diagnostics once (bounded), then finish',
      reason: 'IDE feedback for the last edit is still stabilizing',
    })
  }

  return { kind: 'complete', satisfied: satisfiedConditions(input) }
}
