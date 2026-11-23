
import { parseOperatorPauseDirective } from '../../engine/run/operatorPause.js'
import { evaluateStop, type StopDecision } from '../../engine/run/completionEvaluator.js'
import {
  continuationsThisTurn,
  turnBoundaryIndex,
} from '../../engine/run/continuationLatch.js'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import {
  getRunSnapshot,
  noteRunEvent,
  syncDeliverablesFromTasks,
  syncVerification,
} from '../../engine/run/runCoordinator.js'
import { isTerminalLifecycle } from '../../engine/run/runKernel.js'
import { resolveInvocationContract } from '../../engine/run/invocationContract.js'
import { getActiveMission } from './mission.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { getIsInteractive } from '../../boot/process-state/processState.js'
import { getCwd } from '../../platform/files/cwd.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../platform/environment/envUtils.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import {
  evidenceDemandCount,
  verificationSummary,
  workspaceVerifiable,
} from '../../platform/verification/verificationState.js'

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
    interactive: getIsInteractive(),
    missionArmed: getActiveMission() !== undefined,
  })
  const decision = evaluateStop({
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
  })

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
                : decision.cause,
    })
  }

  switch (decision.kind) {
    case 'continue':
      return { decision, allowStop: true }
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
  return getIsInteractive() || isEnvTruthy(flag)
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
        '../../sessions/walkthrough/assembleWalkthrough.js'
      )
      const { computeWorkingTreeDigestAsync } = await import(
        '../../platform/verification/verificationState.js'
      )
      const { getSessionId } = await import('../../boot/process-state/processState.js')
      const sessionId = String(getSessionId())
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
      } else {
        noteWalkthroughUnwritten(owner, minted.reason)
      }
    } catch (error) {
      noteWalkthroughUnwritten(owner, error instanceof SyntaxError ? 'a record it reads is not valid JSON' : errorMessage(error))
    }
  })()
}

function noteWalkthroughUnwritten(owner: OwnerKey, reason: string): void {
  noteRunEvent(owner, {
    type: 'next-action',
    at: Date.now(),
    action: `the delivered walkthrough could not be written (${reason}) — review the changes in /diff`,
  })
}

export function _resetDeliveryLatchForTesting(): void {
  deliveredRuns.clear()
}
