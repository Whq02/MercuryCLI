// ============================================================================
//  runStopAdapter — the shared role adapter every keep-working Stop hook
//  delegates to.
//
//  One evaluation path: assemble the evidence (run snapshot synced from the
//  REAL task store + owner verification + wording hint), ask the pure
//  completionEvaluator, then map the decision onto the FunctionHook contract
//  (true = allow stop; string = block with a dynamic re-prompt). The
//  continuation LATCH makes the block exact-once per stop attempt across
//  every registered hook — fable + self-check + the default run hook can no
//  longer issue duplicate continuations for one stop.
//
//  Role deltas stay in the CALLING hook (its re-prompt voice, its bus-credit
//  checks, its operator-question allowance); the decision itself is shared.
// ============================================================================

import {
  BLOCKER_DECLARATION_GRAMMAR,
  parseBlockerDeclaration,
} from '../../services/run/blockerDeclaration.js'
import { parseOperatorPauseDirective } from '../../services/run/operatorPause.js'
import { evaluateStop, type StopDecision } from '../../services/run/completionEvaluator.js'
import {
  claimContinuation,
  continuationsThisTurn,
  lastAdmission,
  recordAdmission,
  turnBoundaryIndex,
} from '../../services/run/continuationLatch.js'
import { actionFingerprint } from '../../services/run/progressModel.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import {
  getRunSnapshot,
  noteRunEvent,
  syncDeliverablesFromTasks,
  syncVerification,
} from '../../services/run/runCoordinator.js'
import { isTerminalLifecycle } from '../../services/run/runKernel.js'
import { resolveInvocationContract } from '../../services/run/invocationContract.js'
import { getActiveMission } from './missionHook.js'
import type { Message } from '../../types/message.js'
import { getIsInteractive } from '../../bootstrap/state.js'
import { getCwd } from '../cwd.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  evidenceDemandCount,
  noteEvidenceDemandIssued,
  verificationSummary,
  workspaceVerifiable,
} from '../verification/verificationState.js'

/** Interactive posture without a boot dependency: pre-boot/proof contexts
 *  read as non-interactive (matches headlessMintAllowed's contract). */
function safeIsInteractive(): boolean {
  try {
    return getIsInteractive()
  } catch {
    return false
  }
}

/** Is a /mission armed for the current session? Never throws — pre-boot/proof
 *  contexts (no session id yet) read as no mission. */
function missionArmedForSession(): boolean {
  try {
    return getActiveMission() !== undefined
  } catch {
    return false
  }
}

// turnBoundaryIndex moved to continuationLatch (2.2c) — the latch owns the
// stop-attempt identity end to end, and the mission hook claims through it
// without importing this adapter (no cycle). Re-exported for stability.
export { turnBoundaryIndex }

/** Text of the LAST real user message (the turn boundary) — the operator's
 *  own words for this turn. String content verbatim; block content folds its
 *  text blocks. */
export function turnBoundaryUserText(messages: readonly Message[]): string {
  const idx = turnBoundaryIndex(messages)
  if (idx === -1) return ''
  const m = messages[idx] as { message?: { content?: unknown } } | undefined
  const content = m?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      b =>
        (b as { type?: string })?.type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => (b as { text: string }).text)
    .join('\n')
    .trim()
}

/** Concatenated text of the LAST assistant message in the transcript — the
 *  stop attempt's final prose. ONE copy at the shared adapter seam (the role
 *  hooks' wording detectors read the same text). */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter(
        b =>
          b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
      )
      .map(b => (b as { text: string }).text)
      .join('\n')
      .trim()
  }
  return ''
}

export interface RunStopAdapterOptions {
  /** Hard per-turn continuation ceiling (the role's loop brake). */
  maxBlocks: number
  /** The role's wording hint for tails (false ⇒ evidence-only — the default
   *  Mercury posture; fable/scribe/dungeon pass their detector's verdict). */
  wordingUnfinished: boolean
  /** Owner override (tests); default = the process main owner. */
  owner?: OwnerKey
  signal?: AbortSignal
  /** Truth-record mode (the supervisor-off stop path): fold the decision's
   *  TRUTH events (stop-decision · blocked · completed + artifact) but never
   *  claim a continuation, admission, or evidence demand — the stop always
   *  stands, so recording a 'continuation' would be false. */
  recordOnly?: boolean
}

export interface RunStopVerdict {
  decision: StopDecision
  /** true ⇒ allow the stop; false ⇒ THIS hook won the claim and must block. */
  allowStop: boolean
}

/**
 * Evaluate a stop attempt and settle the continuation claim. Folds the
 * decision into the run's event stream (stop-decision / completed / blocked /
 * continuation + next-action) so the run state and the hook behavior can
 * never disagree.
 */
export async function evaluateStopAttempt(
  messages: readonly Message[],
  opts: RunStopAdapterOptions,
): Promise<RunStopVerdict> {
  const owner = opts.owner ?? processMainOwner()
  const cwd = getCwd()
  const turnIdx = turnBoundaryIndex(messages)

  // Refresh the evidence the evaluator reads (real task store + owner
  // verification). Both degrade silently — the fold keeps last-known truth.
  await syncDeliverablesFromTasks(owner)
  syncVerification(owner, cwd)

  // item 6: an EXPLICIT operator pause/stop settles the run state
  // BEFORE completion evaluation — the paused lifecycle beats open-
  // deliverable pressure in the evaluator, so the demand can never point at
  // overriding a human stop (the AVS field run: "stop the workflow rq lets
  // pause here" → next action still said "Author the three large remaining
  // regions"). The grammar is conservative (operatorPause.ts — terse,
  // verb-anchored, work-object only); resumption stays the kernel's law:
  // only a new operator request reactivates ('request-accepted'), the stop
  // path NEVER auto-resumes.
  {
    const directive = parseOperatorPauseDirective(turnBoundaryUserText(messages))
    if (directive.kind === 'pause') {
      const snap = getRunSnapshot(owner)
      if (
        snap &&
        snap.substantive &&
        !isTerminalLifecycle(snap.lifecycle) &&
        snap.lifecycle !== 'paused'
      ) {
        noteRunEvent(owner, {
          type: 'paused',
          at: Date.now(),
          reason: `operator: "${directive.directive}"`,
        })
      }
    }
  }

  // The typed operator-blocker escape (task #74): a well-formed declaration
  // ending the stop attempt's final text mints the `blocked` run event HERE —
  // the one seam every role hook rides — so the evaluator's blocked branch is
  // reachable. Only a live substantive run can block (a lightweight turn
  // already stops cleanly); a malformed/no-substance declaration is REFUSED
  // with a named reason that reaches the model via the continue re-prompt.
  let blockerRefusal: string | null = null
  {
    const declared = parseBlockerDeclaration(lastAssistantText(messages))
    if (declared.kind === 'declared') {
      const snap = getRunSnapshot(owner)
      if (
        snap &&
        snap.substantive &&
        !isTerminalLifecycle(snap.lifecycle) &&
        snap.lifecycle !== 'blocked'
      ) {
        const declaredAt = Date.now()
        noteRunEvent(owner, {
          type: 'blocked',
          at: declaredAt,
          blocker: {
            description: declared.description,
            ownedBy: 'operator',
            resumeCondition: declared.resumeCondition,
            at: declaredAt,
          },
        })
      }
    } else if (declared.kind === 'refused') {
      blockerRefusal = declared.reason
    }
  }
  const snapshot = getRunSnapshot(owner)

  let verification:
    | {
        state: 'verified' | 'stale' | 'failed' | 'unverified'
        mutationsSinceEvidence: number
        workspaceVerifiable?: boolean
        priorEvidenceDemands?: number
      }
    | null = null
  try {
    const s = verificationSummary(cwd, { skipDigest: true, owner })
    verification = {
      state: s.state,
      mutationsSinceEvidence: s.mutationsSinceEvidence,
      // applicability + the bounded re-arm ride the input so the
      // pure evaluator can refuse the unsatisfiable-demand loop.
      workspaceVerifiable: workspaceVerifiable(cwd, owner),
      priorEvidenceDemands: evidenceDemandCount(owner),
    }
  } catch {
    verification = null
  }

  // the invocation contract, resolved from
  // what this seam knows — interactive posture + the declared-mission state. A
  // plain print/SDK run without a mission is one-shot: settled effects complete
  // it, and the run-state re-prompt never fires on it again.
  const contract = resolveInvocationContract({
    interactive: safeIsInteractive(),
    missionArmed: missionArmedForSession(),
  })
  // the admission revision tuple — every field
  // derives from settled kernel state, so an identical tuple really means
  // "nothing changed since the last admitted continuation".
  const VERIFICATION_RANK = { unverified: 0, stale: 1, failed: 2, verified: 3 } as const
  const revision = snapshot
    ? {
        runRevision: snapshot.totalEvents,
        effectRevision: snapshot.totalChangedPaths * 1009 + snapshot.unresolvedBadEffects,
        evidenceRevision:
          (snapshot.progress?.totalProgress ?? 0) * 31 +
          (verification ? VERIFICATION_RANK[verification.state] : 0),
        externalRevision: snapshot.contextEpoch,
      }
    : undefined
  let decision = evaluateStop({
    snapshot,
    wordingUnfinished: opts.wordingUnfinished,
    continuationsThisTurn: continuationsThisTurn(owner, turnIdx),
    maxContinuationsPerTurn: opts.maxBlocks,
    aborted: opts.signal?.aborted ?? false,
    apiError: false, // query.ts never runs stop hooks on an API-error turn
    verification,
    pendingIdeFeedback: snapshot?.ideFeedback.state === 'pending',
    surface: contract.surface,
    terminalPolicy: contract.terminalPolicy,
    revision,
    priorAdmission: lastAdmission(owner, turnIdx),
  })
  // A refused declaration rides the continue reason so BOTH the re-prompt and
  // the stop-decision event name why it was not honored — the model corrects
  // the declaration instead of re-emitting it until the budget burns out.
  if (blockerRefusal && decision.kind === 'continue') {
    decision = {
      ...decision,
      reason: `${decision.reason} — blocker declaration refused: ${blockerRefusal}`,
    }
  }

  const at = Date.now()
  if (snapshot) {
    noteRunEvent(owner, {
      type: 'stop-decision',
      at,
      decision: decision.kind,
      detail:
        decision.kind === 'continue'
          ? decision.reason
          : decision.kind === 'blocked'
            ? decision.blocker
            : decision.kind === 'complete'
              ? decision.satisfied.join('; ')
              : decision.kind === 'budget-exhausted'
                ? `unfinished: ${decision.unfinished.join('; ') || '(none named)'}`
                : decision.kind === 'handoff'
                  ? `${decision.cause} — unfinished: ${decision.unfinished.join('; ') || '(none named)'} · ${decision.strategiesTried} strateg${decision.strategiesTried === 1 ? 'y' : 'ies'} tried`
                  : decision.cause,
    })
  }

  switch (decision.kind) {
    case 'continue': {
      // Truth-record mode: the stop stands (nothing continues) — the
      // stop-decision above is the whole record; claim nothing.
      if (opts.recordOnly) return { decision, allowStop: true }
      // Exact-once across every hook evaluating this same stop attempt.
      const claimed = claimContinuation(owner, turnIdx, messages.length)
      if (!claimed) return { decision, allowStop: true }
      // bounded re-arm: an ISSUED evidence demand counts against the
      // ceiling (only claimed ones — a losing hook's duplicate never counts).
      if (decision.evidenceDemand) noteEvidenceDemandIssued(owner)
      // A04-A06: the admission receipt — what this admitted continuation saw
      // (the NEXT evaluation refuses an identical tuple + action). The
      // receipt's durable copy rides the continuation event reason below.
      const admissionLine = revision
        ? ` [admission r${revision.runRevision}/e${revision.effectRevision}/v${revision.evidenceRevision}/x${revision.externalRevision} fp:${actionFingerprint(decision.nextAction).slice(0, 8)} #${continuationsThisTurn(owner, turnIdx)}]`
        : ''
      if (revision) {
        recordAdmission(owner, turnIdx, {
          revision,
          nextActionFingerprint: actionFingerprint(decision.nextAction),
          attempt: continuationsThisTurn(owner, turnIdx),
        })
      }
      if (snapshot) {
        noteRunEvent(owner, { type: 'continuation', at, reason: `${decision.reason}${admissionLine}` })
        noteRunEvent(owner, { type: 'next-action', at, action: decision.nextAction })
      }
      return { decision, allowStop: false }
    }
    case 'blocked': {
      // ONE visible blocked transition, then the loop terminates honestly.
      if (snapshot && snapshot.lifecycle !== 'blocked') {
        noteRunEvent(owner, {
          type: 'blocked',
          at,
          blocker: {
            description: decision.blocker,
            ownedBy: 'operator',
            resumeCondition: decision.resumeCondition,
            at,
          },
        })
      }
      return { decision, allowStop: true }
    }
    case 'complete': {
      if (snapshot && snapshot.substantive && snapshot.lifecycle === 'active') {
        noteRunEvent(owner, { type: 'completed', at, satisfied: decision.satisfied })
        mintDeliveryArtifact(owner, snapshot.runId, snapshot.totalChangedPaths > 0)
      }
      return { decision, allowStop: true }
    }
    default:
      // pause / cancel / fail / budget-exhausted: the stop stands; the run
      // event stream already carries the honest state via stop-decision.
      return { decision, allowStop: true }
  }
}

// ── proven delivery ──────────────────────────────────────
// A completed substantive run that changed files mints ONE versioned
// walkthrough through the existing artifact owner (claims carry mercury://
// refs; the store stamps ready-for-review, so the workbench review queue and
// the derived next action offer it without command archaeology). Exactly once
// per runId; best-effort off the stop path — a store failure never blocks the
// completion. The current tree digest rides along so any later mutation
// surfaces the artifact as STALE (the fresh-evidence law).
const deliveredRuns = new Set<string>()

/** Interactive sessions mint on the default-on flag; non-interactive (print/
 *  SDK) mints only on an EXPLICIT truthy opt-in. Never throws (pre-boot and
 *  proof contexts read as non-interactive). Exported for the prover. */
export function headlessMintAllowed(flag: string | undefined): boolean {
  try {
    if (getIsInteractive()) return true
  } catch {
    /* fall through to the explicit-opt-in test */
  }
  return isEnvTruthy(flag)
}

/** Exported for the momentum delivery prover; production calls it only from
 *  the complete settle above. */
export function mintDeliveryArtifact(owner: OwnerKey, runId: string, hasChanges: boolean): void {
  if (!hasChanges) return
  const flag = flagEnv('MERCURY_DELIVERY_ARTIFACT')
  if (isEnvDefinedFalsy(flag)) return
  // ordinary HEADLESS completion mints NO walkthrough — the
  // review store is durable + prune-exempt by declaration, and a `-p` run's
  // operator never sees the review queue (the field's mystery journal came
  // from exactly this path). Explicit review mode (the flag set truthy)
  // still mints exactly one; interactive completion is unchanged.
  if (!headlessMintAllowed(flag)) return
  if (deliveredRuns.has(runId)) return
  deliveredRuns.add(runId)
  void (async () => {
    try {
      const { createWalkthroughArtifact } = await import(
        '../../services/walkthrough/assembleWalkthrough.js'
      )
      const { computeWorkingTreeDigestAsync } = await import(
        '../verification/verificationState.js'
      )
      const { getSessionId } = await import('../../bootstrap/state.js')
      let sessionId = 'unknown-session'
      try {
        sessionId = String(getSessionId())
      } catch {
        /* pre-boot/proof contexts — the artifact still names a producer */
      }
      let treeDigest: string | undefined
      try {
        treeDigest = (await computeWorkingTreeDigestAsync(getCwd())) ?? undefined
      } catch {
        treeDigest = undefined
      }
      const minted = createWalkthroughArtifact({
        owner,
        sessionId,
        ...(treeDigest !== undefined && { treeDigest }),
      })
      if (minted.ok) {
        noteRunEvent(owner, {
          type: 'next-action',
          at: Date.now(),
          action: `review the delivered walkthrough v${minted.value.version} (/diff · /workbench)`,
        })
      }
    } catch {
      /* delivery is best-effort — the completion receipt stands */
    }
  })()
}

/** TEST-ONLY: reset the once-per-run delivery latch between prover scenarios. */
export function _resetDeliveryLatchForTesting(): void {
  deliveredRuns.clear()
}

/** Per-field budget for evaluator text interpolated into a re-prompt. The
 *  evaluator's reasons and next actions are derived from task titles and run
 *  state — ordinarily well under this; the budget only bites pathology (a
 *  runaway deliverable title) so the re-prompt stays a bounded contract. */
export const REPROMPT_FIELD_BUDGET = 800

/** Bound one evaluator-derived field for re-prompt interpolation: control
 *  characters (except newline/tab) dropped, length clamped with a visible
 *  truncation marker. */
export function boundRepromptField(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return clean.length <= REPROMPT_FIELD_BUDGET ? clean : `${clean.slice(0, REPROMPT_FIELD_BUDGET)} […]`
}

/** Compose a role re-prompt with the evaluator's concrete next action, plus
 *  the ONE honest escape: the typed blocker grammar, taught at the exact
 *  moment a genuinely blocked model needs it (task #74). The interpolated
 *  evaluator fields are bounded (boundRepromptField) so the re-prompt is a
 *  fixed-shape contract whatever the run state carries. */
export function repromptWithNextAction(roleReprompt: string, decision: StopDecision): string {
  if (decision.kind !== 'continue') return roleReprompt
  return (
    `${roleReprompt}\n\nRun state: ${boundRepromptField(decision.reason)}. Next concrete action: ${boundRepromptField(decision.nextAction)}.` +
    `\nIf you are genuinely blocked on input only the operator can provide, end your message with ${BLOCKER_DECLARATION_GRAMMAR} — that records the blocker and ends the loop honestly.`
  )
}
