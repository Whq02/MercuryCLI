import { productionDeps } from '../../../engine/turn-entry/turnLoopDeps.js'
import type { LegacyTurnYield } from '../../../engine/loop/project-legacy.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { DeadlineExceededError, armInactivityDeadline } from '../../../platform/async/deadline.js'
import { type RecoveryBudget, RecoveryBudgetSpentError, recoveryAnswerRefills, recoveryNoticeFacts, refillRecoveryBudget } from '../../../engine/requests/recoveryBudget.js'
import { heldBusyRetryNotice } from '../../../models/roads/busyRetry.js'
import { reviewerRefusal } from '../reviewerPolicy.js'
import { scoutRefusal } from '../scoutPolicy.js'
import type { crewmateStalledError, declaredRecoveryWaitMs, RecoveryAccountant, RunCrewmateParams } from '../runCrewmate.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../../platform/async/timers.js'

export interface CrewmateRun {
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

type StalledNeeds = { agentDefinition: RunCrewmateParams['agentDefinition']; agentId: AgentId; idleLimitMs: number; startedAt: number; agentStalledError: typeof crewmateStalledError }

export function stalledErrorOf(run: CrewmateRun, { agentDefinition, agentId, idleLimitMs, startedAt, agentStalledError }: StalledNeeds) {
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

export function unarmedCrewmateRun(): CrewmateRun {
  return { eventsSeen: 0, toolUsesSeen: 0, deferredTouch: null, retryStalledRequest: null, stoppedAfterRetry: false, watchdog: armInactivityDeadline({ seam: 'crewmate', limitMs: 0 }), throttled: null, cuttingWait: { declaredMs: 0, honoredMs: 0 }, pendingAsks: 0, askHeartbeat: null }
}

export function armWatchdogOf(run: CrewmateRun, { agentDefinition, agentId, idleLimitMs, stalledError, abortController }: { agentDefinition: RunCrewmateParams['agentDefinition']; agentId: AgentId; idleLimitMs: number; stalledError: () => DeadlineExceededError; abortController: AbortController }) {
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

export function cutAtBudgetOf(run: CrewmateRun, { recovery, abortController }: { recovery: RecoveryBudget; abortController: AbortController }) {
  const cutAtBudget = (cutting: { declaredMs: number; honoredMs: number }): void => {
    run.cuttingWait = cutting
    run.throttled = new RecoveryBudgetSpentError(recovery, run.cuttingWait)
    abortController.abort(run.throttled)
  }
  return cutAtBudget
}

export function touchThroughOf(run: CrewmateRun) {
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

export function askLivelyOf(run: CrewmateRun, canUseTool: NonNullable<RunCrewmateParams['canUseTool']>, { idleLimitMs, reviewReceipt, worktreePath, readOnlyScout, onPendingAsks }: { idleLimitMs: number; reviewReceipt: string | undefined; worktreePath: RunCrewmateParams['worktreePath']; readOnlyScout: boolean; onPendingAsks: RunCrewmateParams['onPendingAsks'] }) {
  const askHeartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(idleLimitMs / 4)))
  return (async (...args: Parameters<NonNullable<typeof canUseTool>>) => {
    if (reviewReceipt !== undefined) {
      const refusal = await reviewerRefusal(args[0], args[1], reviewReceipt, worktreePath!)
      if (refusal !== null) return { behavior: 'deny', message: refusal }
    }
    if (readOnlyScout) {
      const refusal = await scoutRefusal(args[0], args[1])
      if (refusal !== null) return { behavior: 'deny', message: refusal }
    }
    run.pendingAsks++
    onPendingAsks?.(run.pendingAsks)
    run.watchdog.touch()
    if (run.askHeartbeat === null) {
      run.askHeartbeat = startInterval(() => run.watchdog.touch(), askHeartbeatMs)
      run.askHeartbeat.unref?.()
    }
    try {
      return await canUseTool(...args)
    } finally {
      run.pendingAsks--
      onPendingAsks?.(run.pendingAsks)
      if (run.pendingAsks === 0 && run.askHeartbeat !== null) {
        stopInterval(run.askHeartbeat)
        run.askHeartbeat = null
      }
      run.watchdog.touch()
    }
  }) as NonNullable<typeof canUseTool>
}

export function callModelOf(run: CrewmateRun, { deps, agentId }: { deps: ReturnType<typeof productionDeps>; agentId: AgentId }) {
  const callModel: typeof deps.callModel = async function* (request) {
    let retried = false
    for (;;) {
      const requestController = new AbortController()
      const forwardAbort = (): void => requestController.abort(request.signal.reason)
      if (request.signal.aborted) forwardAbort()
      else request.signal.addEventListener('abort', forwardAbort, { once: true })
      let produced = false
      let resend = false
      run.stoppedAfterRetry = false
      run.retryStalledRequest = error => {
        if (request.signal.aborted) return false
        if (retried) run.stoppedAfterRetry = true
        if (requestController.signal.aborted || produced || retried) return false
        retried = true
        resend = true
        logForDebugging(`runAgent: ${agentId} stalled request — retrying the same request once on ${request.options.model}`, { level: 'warn' })
        requestController.abort(error)
        return true
      }
      try {
        for await (const message of deps.callModel({ ...request, signal: requestController.signal })) {
          if (resend) continue
          if (message.type === 'assistant' || message.type === 'stream_event') produced = true
          yield message
        }
      } catch (error) {
        if (!resend || request.signal.aborted) throw error
      } finally {
        run.retryStalledRequest = null
        request.signal.removeEventListener('abort', forwardAbort)
        requestController.abort()
      }
      if (!resend || request.signal.aborted) return
    }
  }
  return callModel
}

type ObserveNeeds = { recovery: RecoveryBudget; accountant: RecoveryAccountant; onQueryProgress: RunCrewmateParams['onTurnProgress']; touchThrough: (declaredMs: number) => void; declaredRecoveryWaitMs: typeof declaredRecoveryWaitMs }

export function observeProgressOf(run: CrewmateRun, { recovery, accountant, onQueryProgress, touchThrough, declaredRecoveryWaitMs }: ObserveNeeds) {
  const observeProgress = (message: LegacyTurnYield): void => {
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

export function sdkStatusOf(run: CrewmateRun, { onQueryProgress, accountant, touchThrough }: { onQueryProgress: RunCrewmateParams['onTurnProgress']; accountant: RecoveryAccountant; touchThrough: (declaredMs: number) => void }) {
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
