
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

function safeIsInteractive(): boolean {
  try {
    return getIsInteractive()
  } catch {
    return false
  }
}

function missionArmedForSession(): boolean {
  try {
    return getActiveMission() !== undefined
  } catch {
    return false
  }
}

export { turnBoundaryIndex }

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
  maxBlocks: number
  wordingUnfinished: boolean
  owner?: OwnerKey
  signal?: AbortSignal
  recordOnly?: boolean
}

export interface RunStopVerdict {
  decision: StopDecision
  allowStop: boolean
}

export async function evaluateStopAttempt(
  messages: readonly Message[],
  opts: RunStopAdapterOptions,
): Promise<RunStopVerdict> {
  const owner = opts.owner ?? processMainOwner()
  const cwd = getCwd()
  const turnIdx = turnBoundaryIndex(messages)

  await syncDeliverablesFromTasks(owner)
  syncVerification(owner, cwd)

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
      workspaceVerifiable: workspaceVerifiable(cwd, owner),
      priorEvidenceDemands: evidenceDemandCount(owner),
    }
  } catch {
    verification = null
  }

  const contract = resolveInvocationContract({
    interactive: safeIsInteractive(),
    missionArmed: missionArmedForSession(),
  })
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
    apiError: false,
    verification,
    pendingIdeFeedback: snapshot?.ideFeedback.state === 'pending',
    surface: contract.surface,
    terminalPolicy: contract.terminalPolicy,
    revision,
    priorAdmission: lastAdmission(owner, turnIdx),
  })
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
      if (opts.recordOnly) return { decision, allowStop: true }
      const claimed = claimContinuation(owner, turnIdx, messages.length)
      if (!claimed) return { decision, allowStop: true }
      if (decision.evidenceDemand) noteEvidenceDemandIssued(owner)
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
      return { decision, allowStop: true }
  }
}

const deliveredRuns = new Set<string>()

export function headlessMintAllowed(flag: string | undefined): boolean {
  try {
    if (getIsInteractive()) return true
  } catch {
  }
  return isEnvTruthy(flag)
}

export function mintDeliveryArtifact(owner: OwnerKey, runId: string, hasChanges: boolean): void {
  if (!hasChanges) return
  const flag = flagEnv('MERCURY_DELIVERY_ARTIFACT')
  if (isEnvDefinedFalsy(flag)) return
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
    }
  })()
}

export function _resetDeliveryLatchForTesting(): void {
  deliveredRuns.clear()
}

export const REPROMPT_FIELD_BUDGET = 800

export function boundRepromptField(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return clean.length <= REPROMPT_FIELD_BUDGET ? clean : `${clean.slice(0, REPROMPT_FIELD_BUDGET)} […]`
}

export function repromptWithNextAction(roleReprompt: string, decision: StopDecision): string {
  if (decision.kind !== 'continue') return roleReprompt
  return (
    `${roleReprompt}\n\nRun state: ${boundRepromptField(decision.reason)}. Next concrete action: ${boundRepromptField(decision.nextAction)}.` +
    `\nIf you are genuinely blocked on input only the operator can provide, end your message with ${BLOCKER_DECLARATION_GRAMMAR} — that records the blocker and ends the loop honestly.`
  )
}
