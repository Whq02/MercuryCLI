import { productionDeps } from '../../../query/deps.js'
import type { LegacyQueryYield } from '../../../run-core/project-legacy.js'
import type { Message } from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import { logForDebugging } from '../../../utils/debug.js'
import { DeadlineExceededError, armInactivityDeadline } from '../../../utils/deadline.js'
import { type RecoveryBudget, RecoveryBudgetSpentError, recoveryAnswerRefills, recoveryNoticeFacts, refillRecoveryBudget } from '../../../services/api/recoveryBudget.js'
import { heldBusyRetryNotice } from '../../../services/providers/busyRetry.js'
import { reviewerRefusal } from '../reviewerPolicy.js'
import { scoutRefusal } from '../scoutPolicy.js'
import type { agentStalledError, declaredRecoveryWaitMs, RecoveryAccountant, RunAgentParams } from '../runAgent.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export interface AgentRun {
  eventsSeen: number
  toolUsesSeen: number
  deferredTouch: ReturnType<typeof setTimeout> | null
  retryStalledRequest: ((error: DeadlineExceededError) => boolean) | null
  stoppedAfterRetry: boolean
  watchdog: ReturnType<typeof armInactivityDeadline>
  throttled: Error | null
  cuttingWait: { declaredMs: number; honoredMs: number }
  pendingAsks: number
  askHeartbeat: ReturnType<typeof setInterval> | null
}

type StalledNeeds = { agentDefinition: RunAgentParams['agentDefinition']; agentId: AgentId; idleLimitMs: number; startedAt: number; agentStalledError: typeof agentStalledError }

export function stalledErrorOf(run: AgentRun, { agentDefinition, agentId, idleLimitMs, startedAt, agentStalledError }: StalledNeeds) {
  const stalledError = (): DeadlineExceededError =>
    agentStalledError({
      agentType: agentDefinition.agentType,
      agentId,
      limitMs: idleLimitMs,
      elapsedMs: Date.now() - startedAt,
      events: run.eventsSeen,
      toolUses: run.toolUsesSeen,
      retried: run.stoppedAfterRetry,
    })
  return stalledError
}

export function unarmedAgentRun(): AgentRun {
  return { eventsSeen: 0, toolUsesSeen: 0, deferredTouch: null, retryStalledRequest: null, stoppedAfterRetry: false, watchdog: armInactivityDeadline({ seam: 'crewmate', limitMs: 0 }), throttled: null, cuttingWait: { declaredMs: 0, honoredMs: 0 }, pendingAsks: 0, askHeartbeat: null }
}

export function armWatchdogOf(run: AgentRun, { agentDefinition, agentId, idleLimitMs, stalledError, abortController }: { agentDefinition: RunAgentParams['agentDefinition']; agentId: AgentId; idleLimitMs: number; stalledError: () => DeadlineExceededError; abortController: AbortController }) {
  const armWatchdog = (): ReturnType<typeof armInactivityDeadline> => armInactivityDeadline({
    seam: `crewmate ${agentDefinition.agentType} (${agentId})`,
    limitMs: idleLimitMs,
    onExpire: error => {
      if (run.retryStalledRequest?.(error)) {
        run.watchdog = armWatchdog()
        return
      }
      const stalled = stalledError()
      logForDebugging(`runAgent: ${agentId} stalled${run.stoppedAfterRetry ? ' on the first and second attempts' : ''} — ${stalled.message}`)
      abortController.abort(stalled)
    },
  })
  return armWatchdog
}

export function cutAtBudgetOf(run: AgentRun, { recovery, abortController }: { recovery: RecoveryBudget; abortController: AbortController }) {
  const cutAtBudget = (cutting: { declaredMs: number; honoredMs: number }): void => {
    run.cuttingWait = cutting
    run.throttled = new RecoveryBudgetSpentError(recovery, run.cuttingWait)
    abortController.abort(run.throttled)
  }
  return cutAtBudget
}

export function touchThroughOf(run: AgentRun) {
  const touchThrough = (declaredMs: number): void => {
    run.watchdog.touch()
    if (declaredMs <= 0) return
    if (run.deferredTouch !== null) stopTimeout(run.deferredTouch)
    run.deferredTouch = startTimeout(() => {
      run.deferredTouch = null
      run.watchdog.touch()
    }, declaredMs)
    run.deferredTouch.unref?.()
  }
  return touchThrough
}

export function askLivelyOf(run: AgentRun, canUseTool: NonNullable<RunAgentParams['canUseTool']>, arg2: { idleLimitMs: number; reviewReceipt: string | undefined; worktreePath: RunAgentParams['worktreePath']; readOnlyScout: boolean; onPendingAsks: RunAgentParams['onPendingAsks'] }): Unbuilt {
  return notBuilt('src/tools/AgentTool/runAgent/watch.ts:87')
}

export function callModelOf(run: AgentRun, arg1: { deps: ReturnType<typeof productionDeps>; agentId: AgentId }): Unbuilt {
  return notBuilt('src/tools/AgentTool/runAgent/watch.ts:119')
}

type ObserveNeeds = { recovery: RecoveryBudget; accountant: RecoveryAccountant; onQueryProgress: RunAgentParams['onQueryProgress']; touchThrough: (declaredMs: number) => void; declaredRecoveryWaitMs: typeof declaredRecoveryWaitMs }

export function observeProgressOf(run: AgentRun, { recovery, accountant, onQueryProgress, touchThrough, declaredRecoveryWaitMs }: ObserveNeeds) {
  const observeProgress = (message: LegacyQueryYield): void => {
    run.eventsSeen++
    touchThrough(declaredRecoveryWaitMs(message))
    const notice = recoveryNoticeFacts(message)
    if (notice !== null) {
      accountant.wait(notice, true)
    } else if (accountant.standing() && (message as { type?: string }).type !== 'progress') {
      accountant.spoke()
    }
    if (recoveryAnswerRefills(message)) refillRecoveryBudget(recovery)
    if ((message as { type?: string }).type === 'assistant') {
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content) && content.some(block => (block as { type?: string })?.type === 'tool_use')) {
        run.toolUsesSeen++
      }
    }
    onQueryProgress?.(message as Message)
  }
  return observeProgress
}

export function sdkStatusOf(run: AgentRun, { onQueryProgress, accountant, touchThrough }: { onQueryProgress: RunAgentParams['onQueryProgress']; accountant: RecoveryAccountant; touchThrough: (declaredMs: number) => void }) {
  return (status: unknown) => {
  if (status === null || typeof status !== 'object') return
  if ('streamActivity' in status) {
    const atMs = (status as { streamActivity?: unknown }).streamActivity
    if (typeof atMs !== 'number') return
    run.watchdog.touch()
    onQueryProgress?.({ type: 'stream_activity', atMs })
    return
  }
  if ('wait' in status) {
    const wait = (status as { wait?: unknown }).wait ?? null
    const heldNotice = heldBusyRetryNotice(wait)
    if (heldNotice !== null) {
      const facts = recoveryNoticeFacts(heldNotice)
      if (facts !== null) {
        accountant.wait(facts, false)
        touchThrough(facts.declaredMs)
      }
      return
    }
    onQueryProgress?.({ type: 'request_wait', wait })
  }
  }
}
