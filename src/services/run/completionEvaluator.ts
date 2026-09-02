// ============================================================================
//  completionEvaluator — the ONE pure stop/continue decision (Sol 5.6
//  frontier sprint). Replaces wording-first stopping.
//
//  Every keep-working Stop hook (default Mercury run hook, fable,
//  Scribe/Implementer, dungeon seats) delegates here through a small role
//  adapter. The decision is EVIDENCE-BASED: deliverable/task state, real tool
//  effects, mutation-after-evidence, failed/indeterminate mutating effects,
//  pending IDE stabilization, blocker ownership, abort signal, and the
//  continuation budget. The last paragraph's WORDING is only a compatibility
//  hint when no run contract exists (a lightweight conversational turn).
//
//  Pure + React-free: callers assemble StopEvaluationInput; this module
//  never reads ambient state, so proof scripts exercise the real decision.
// ============================================================================

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
      /** True when this continue IS the mutation-evidence demand — the
       *  adapter counts these into the bounded re-arm. */
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
      /** the typed stagnation settle — zero eligible
       *  progress across the allowed attempts (one replan included) hands
       *  off with evidence instead of burning to the raw budget fuse. */
      kind: 'handoff'
      cause: string
      unfinished: string[]
      strategiesTried: number
      /** 2.6: the rendered handoff payload (outcome · changed · strategies ·
       *  evidence · why-repeat-fails · reopening input · resume ids). */
      report: string
    }

export interface StopEvaluationInput {
  /** The owner's run snapshot — null/non-substantive ⇒ lightweight turn. */
  snapshot: RunSnapshot | null
  /** The wording-only compatibility hint (isUnfinishedTail on the tail). */
  wordingUnfinished: boolean
  /** Continuations already issued for THIS stop's turn (all hooks pooled). */
  continuationsThisTurn: number
  /** Hard per-turn continuation ceiling (the loop brake). */
  maxContinuationsPerTurn: number
  /** The conversation's abort signal state. */
  aborted: boolean
  /** The turn ended on an API error (never continue — death-spiral class). */
  apiError: boolean
  /** Owner verification summary at stop time (null ⇒ evidence model off). */
  verification: {
    state: 'verified' | 'stale' | 'failed' | 'unverified'
    mutationsSinceEvidence: number
    /** Does the workspace carry ANY recognizable verification machinery?
     *  (applicability: demanding gate evidence in a workspace with
     *  none is unsatisfiable by construction — the unbounded-demand
     *  loop class.) Absent ⇒ treated as verifiable (the conservative legacy
     *  posture for callers that predate the field). */
    workspaceVerifiable?: boolean
    /** Evidence demands already issued since the last mutation/evidence —
     *  the bounded re-arm's counter (reset by any new mutation, so real
     *  new work always re-arms the nag). */
    priorEvidenceDemands?: number
  } | null
  /** A post-edit IDE diagnostic transaction is still pending/unstable. */
  pendingIdeFeedback: boolean
  /** the resolved surface. Absent ⇒
   *  the pre-2.2 interactive posture (callers that predate the contract). */
  surface?: 'interactive' | 'print' | 'sdk' | 'worker' | 'workflow' | 'external'
  /** The surface's terminal policy — 'one-shot' completes on settled
   *  effects (A01-A03) unless verification was explicitly requested. */
  terminalPolicy?: 'operator-led' | 'one-shot' | 'client-led' | 'mission-led'
  /** The adapter observed the SAME normalized strategy repeating with no new
   *  evidence (the 2.1 fingerprint law; the folded phase also carries it). */
  strategyRepeated?: boolean
  /** A prerequisite/world change legitimately re-armed the repeat (S3). */
  preconditionChanged?: boolean
  /** the admission revision tuple at THIS
   *  evaluation — runRevision (event count) · effectRevision (settled
   *  effect/changed-path state) · evidenceRevision (eligible progress +
   *  verification state) · externalRevision (context epoch / external
   *  inputs). The same tuple + the same nextActionFingerprint may not open
   *  another provider call. */
  revision?: {
    runRevision: number
    effectRevision: number
    evidenceRevision: number
    externalRevision: number
  }
  /** What the LAST admitted continuation saw (from the latch) — the
   *  comparison state; null/absent ⇒ nothing admitted yet this turn. */
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

/** The bounded re-arm ceiling: a mutation-evidence demand that
 *  produced no new evidence twice settles honestly instead of looping — any
 *  NEW mutation resets the counter, so genuinely ongoing work always re-arms
 *  the nag. An unbounded demand loop ends only on the operator's
 *  interrupt. */
const MAX_EVIDENCE_DEMANDS = 2

/** What "complete" was allowed to mean — surfaced in the run receipt. */
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

/**
 * The decision. Deterministic given its input; hooks map `continue` to one
 * blocking re-prompt (exactly once per stop attempt, via the continuation
 * latch) and everything else to an allowed stop with the matching run event.
 */
export function evaluateStop(input: StopEvaluationInput): StopDecision {
  // Hard outs first — these never continue, whatever the run state says.
  if (input.aborted) return { kind: 'cancel', cause: 'operator interrupt (abort signal)' }
  if (input.apiError) return { kind: 'fail', cause: 'API error terminated the turn' }
  // An operator-owned blocker terminates the loop with ONE visible blocked
  // transition — never repeated invisible nudges. Checked ABOVE the budget
  // brake (task #74): a blocker declared on the last budgeted continuation
  // is the run's real state, strictly more informative than budget-exhausted.
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
    // the fuse is not progress-blind — REAL eligible
    // progress since the last decision renews the lease at the boundary.
    // Zero-progress runs still settle here (the visible final fuse, SS-33).
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
  // No run contract (or a run that never became substantive): the wording
  // hint is all there is — the pre-slice-2 compatibility behavior.
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

  // Terminal runs never restart from a stop evaluation.
  if (isTerminalLifecycle(snap.lifecycle)) {
    return { kind: 'complete', satisfied: [`run already ${snap.lifecycle}`] }
  }

  if (snap.lifecycle === 'paused') {
    return { kind: 'pause', cause: snap.phaseReason || 'run paused' }
  }

  // a ONE-SHOT surface completes when the
  // requested effects settled and nothing is in flight — the evidence gap is
  // receipt-recorded, never a run-state continuation. Verification stays
  // available on explicit request (that request declares a mission-led policy).
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

  // the stagnation escalation over the generic
  // continuation lanes — computed from the 2.1 progress model. Eligible
  // progress (or a changed precondition) re-arms; evidence-demand lanes keep
  // their own bound and are never escalated here.
  const progressState = snap.progress
  const noNewProgress = (progressState?.progressSinceDecision ?? 0) === 0
  const strategyRepeated =
    input.strategyRepeated === true ||
    progressState?.phase === 'replan-required' ||
    progressState?.phase === 'handoff-required'
  const rearmed = input.preconditionChanged === true
  const escalate = (candidate: StopDecision): StopDecision => {
    if (candidate.kind !== 'continue' || candidate.evidenceDemand === true) return candidate
    // A04-A06: an unchanged revision tuple + the same next-action
    // fingerprint may not open another provider call — refuse the
    // re-admission with the typed handoff, whatever the attempt count.
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
      // The ONE replan: same continue lane, explicitly different directive —
      // repeating the prior next action verbatim is what S3 forbids.
      return {
        ...candidate,
        nextAction: `REPLAN: the prior approach earned no new evidence — change strategy (different tool family, target, or decomposition), then: ${candidate.nextAction}`,
        reason: `${candidate.reason} — replan directive (no eligible progress since the last decision)`,
      }
    }
    return candidate
  }

  // Evidence-based continuation conditions, most concrete first.
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
      // BOUNDED RE-ARM: the demand produced nothing twice and no
      // new mutation re-armed it — looping a third time is the
      // unsatisfiable spiral. Settle honestly: the receipt names the
      // unverified mutations instead of the gate blocking forever.
      return {
        kind: 'complete',
        satisfied: [
          ...satisfiedConditions(input),
          `UNSETTLED: ${v.mutationsSinceEvidence} mutation(s) without evidence after ${demands} demand(s) — recorded, not blocking`,
        ],
      }
    }
    if (v.workspaceVerifiable === false) {
      // APPLICABILITY: no verification machinery exists here — the
      // honest evidence class is reading the changed artifacts back (which
      // mints the read-back settlement row and clears this counter).
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
    // The failed branch is DEMAND-BOUNDED too (wave finding 4): a subject who
    // cannot make the suite green — a foreign repo with a pre-existing red
    // test, a Makefile whose bare probe passed but whose `make test` has no
    // rule — must settle honestly instead of looping to budget exhaustion
    // (the same unsatisfiable shape in this arm). Red evidence rows no
    // longer reset the budget (verificationState), so the bound holds.
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

  // Everything concrete is satisfied — the run is complete EVEN IF the
  // wording sounds unfinished ("I'll run the gate next" after the gate ran).
  return { kind: 'complete', satisfied: satisfiedConditions(input) }
}
