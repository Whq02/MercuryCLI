import { API_ERROR_MESSAGE_PREFIX } from '../../../api/errors.js'
import {
  createSystemAPIErrorMessage,
} from '../../../../utils/messages.js'
import { retryNoticeWait, retryReasonWords } from '../../streamIdleBudget.js'
import { providerWaitIsWindow, retrySeconds } from '../../../api/recoveryBudget.js'
import { NetworkOutageError, nextReconnect, openReconnectLadder, ReconnectBudgetSpentError } from '../../../api/reconnectLadder.js'
import { sleep } from '../../../../utils/sleep.js'
import { heldBusyRetryWait, nextBusyRetry, openBusyRetryLadder, takesBusyLadder } from '../../busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords, isEmptyStreamFault } from '../../emptyStreamRetry.js'
import { logForDebugging } from '../../../../utils/debug.js'
import type { CallModelYield } from '../../callModelContract.js'
import { OPENAI_MAX_ATTEMPTS, apiErrorMessage, openaiRetryDelayMs } from './faults.js'
import { withEffort, type AttemptFault, type FaultStep, type FaultStepFn, type OpenaiTurn } from './turnState.js'

async function* reconnectOnOutage(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, FaultStep> {
  const { options, signal } = turn
  const { outcome, typed, wireDetail, singleShot } = fault
  const outage = outcome.retryEligible && !singleShot ? outcome.fault.outage : undefined
  if (outage !== undefined) {
    const now = Date.now()
    const ladder = turn.reconnect ?? openReconnectLadder(now, outage)
    turn.reconnect = ladder
    const step = nextReconnect(ladder, outage, now)
    const notice = createSystemAPIErrorMessage(new NetworkOutageError(step, Object.assign(new Error(outcome.fault.message), { code: outage.code })), step.waitMs, step.reconnect, step.of)
    logForDebugging(`[openai] network outage (${wireDetail}) — ${notice.error.message}`)
    yield notice
    options.onWait?.({ kind: 'retry', attempt: step.reconnect, of: step.of, reason: retryReasonWords(undefined, notice.error.message), delayMs: step.waitMs, sinceMs: now })
    if (step.waitMs <= 0) {
      yield withEffort(turn, apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${new ReconnectBudgetSpentError(ladder, now, undefined).message}`, typed, outcome.fault.code))
      return { kind: 'end' }
    }
    await sleep(step.waitMs, signal)
    if (signal.aborted) return { kind: 'end' }
    return { kind: 'again' }
  }
  if (outcome.fault.status !== undefined) turn.reconnect = undefined
  return { kind: 'go_on' }
}

async function* retryBusy(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, FaultStep> {
  const { options, signal } = turn
  const { outcome, typed, askedMs, wireDetail, singleShot, reissueAtServedWord } = fault
  if (outcome.retryEligible && !singleShot && !reissueAtServedWord && takesBusyLadder(outcome.fault, typed) && !providerWaitIsWindow(askedMs)) {
    const ladder = turn.busy?.ladder ?? openBusyRetryLadder(Date.now())
    turn.busy = { ladder, fault: outcome.fault }
    const step = nextBusyRetry(ladder, askedMs, Date.now())
    if (step !== null) {
      logForDebugging(`[openai] busy refusal (${wireDetail}) — retry ${step.attempt} of ${step.of} after ${retrySeconds(step.waitMs)}${step.quiet ? ' inside the quiet window' : ''}`)
      const notice = createSystemAPIErrorMessage(
        Object.assign(new Error(outcome.fault.message), {
          ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
          ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
        }),
        step.waitMs,
        step.attempt,
        step.of,
      )
      if (!step.quiet) {
        yield notice
        options.onWait?.(retryNoticeWait(notice))
      } else if (options.agentId !== undefined) options.onWait?.(heldBusyRetryWait(step, notice))
      await sleep(step.waitMs, signal)
      if (signal.aborted) return { kind: 'end' }
      return { kind: 'next' }
    }
    logForDebugging(`[openai] busy refusal (${wireDetail}) — the retry ladder is spent after ${ladder.waitsMs.length} retries and ${retrySeconds(ladder.spentMs)} of waiting`)
  }
  return { kind: 'go_on' }
}

async function* retryEmptyEnd(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, FaultStep> {
  const { options, signal, busy, turnStartedAtMs } = turn
  const { outcome, wireDetail, singleShot, reissueAtServedWord } = fault
  turn.emptyEnd = busy === undefined && !singleShot && !reissueAtServedWord && outcome.retryEligible && isEmptyStreamFault(outcome.fault)
  if (turn.emptyEnd) {
    turn.emptyEnds++
    if (turn.emptyEnds < EMPTY_STREAM_TRIES) {
      const waitMs = emptyStreamRetryWaitMs()
      const notice = emptyStreamRetryNotice({ provider: 'OpenAI', detail: outcome.fault.code, attempt: turn.emptyEnds + 1, waitMs })
      logForDebugging(`[openai] ${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${turn.emptyEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
      yield notice
      options.onWait?.(retryNoticeWait(notice))
      await sleep(waitMs, signal)
      if (signal.aborted) return { kind: 'end' }
      return { kind: 'again' }
    }
    logForDebugging(`[openai] ${emptyStreamSpentWords('OpenAI', Date.now() - turnStartedAtMs)} (${wireDetail})`, { level: 'error' })
  }
  return { kind: 'go_on' }
}

async function* retryOnce(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, FaultStep> {
  const { options, signal, emptyEnd, busy } = turn
  const { outcome, askedMs, singleShot, reissueAtServedWord, attempt } = fault
  const retryable =
    !emptyEnd &&
    !providerWaitIsWindow(askedMs) &&
    (reissueAtServedWord || (busy === undefined && !singleShot && outcome.retryEligible && outcome.fault.retryable && attempt < OPENAI_MAX_ATTEMPTS))
  if (retryable) {
    const delayMs = Math.max(openaiRetryDelayMs(attempt), askedMs ?? 0)
    const notice = createSystemAPIErrorMessage(
      Object.assign(new Error(outcome.fault.message), {
        ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
        ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
      }),
      delayMs,
      attempt,
      OPENAI_MAX_ATTEMPTS - 1,
    )
    yield notice
    options.onWait?.(retryNoticeWait(notice))
    await sleep(delayMs, signal)
    if (signal.aborted) return { kind: 'end' }
    return { kind: 'next' }
  }
  return { kind: 'go_on' }
}

const RETRY_STEPS: readonly FaultStepFn[] = [reconnectOnOutage, retryBusy, retryEmptyEnd, retryOnce]

export async function* retryOnFault(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, FaultStep> {
  for (const step of RETRY_STEPS) {
    const answer = yield* step(turn, fault)
    if (answer.kind !== 'go_on') return answer
  }
  return { kind: 'go_on' }
}
