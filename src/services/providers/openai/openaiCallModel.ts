import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { classifyImageRefusalFault } from '../../api/mediaRefusal.js'
import {
  createSystemAPIErrorMessage,
} from '../../../utils/messages.js'
import { noteRunPhase } from '../../../utils/runPhases.js'
import {
  resolveOpenaiRequestAuth,
} from './openaiAccounts.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { rejectOpenaiCacheRetention } from './openaiCacheRetention.js'
import { retryNoticeWait, retryReasonWords } from '../streamIdleBudget.js'
import { providerWaitIsWindow, retrySeconds } from '../../api/recoveryBudget.js'
import { NetworkOutageError, nextReconnect, openReconnectLadder, ReconnectBudgetSpentError } from '../../api/reconnectLadder.js'
import { sleep } from '../../../utils/sleep.js'
import { heldBusyRetryWait, nextBusyRetry, openBusyRetryLadder, takesBusyLadder } from '../busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords, isEmptyStreamFault } from '../emptyStreamRetry.js'
import { configuredProviderKeyCommand, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import {
  requestCarriesInputImage,
} from './responsesBridge.js'
import { logForDebugging } from '../../../utils/debug.js'
import { OPENAI_MAX_ATTEMPTS, apiErrorMessage, openaiFaultToTypedError, openaiRetryDelayMs, overflowOf } from './openaiCallModel/faults.js'
import { prepareOpenaiTurn } from './openaiCallModel/prepareTurn.js'
import { settleOpenaiTurn } from './openaiCallModel/turnSettled.js'
import { streamOneOpenaiAttempt } from './openaiCallModel/attempt.js'
import { reissueAtServedEffort, reissueTextForm, trimResumedTranscript } from './openaiCallModel/faultReissue.js'
import { refuseTurn, refuseUsageLimit } from './openaiCallModel/faultRefusal.js'
import { effortOnWire, withEffort, type AttemptFault } from './openaiCallModel/turnState.js'

export { openaiLiveProofState } from './openaiCallModel/turnSettled.js'
export { effortVocabularyRefusalOf, openaiFaultToTypedError, openaiRetryDelayMs } from './openaiCallModel/faults.js'
export { toBridgeMessages } from './openaiCallModel/bridgeMessages.js'
export { buildProviderUsageReceipt, mapOpenaiUsageToAnthropic, replayableItems } from './openaiCallModel/attemptSettle.js'
export { imagesSupportedForLiveModel, imagesSupportedForModel, type ImagesSupportedSubject } from './openaiCallModel/images.js'
export { streamOneOpenaiAttempt } from './openaiCallModel/attempt.js'

export async function* openaiCallModel(params: CallModelParams): CallModelStream {
  yield* openaiTurn(params)
}

async function* openaiTurn(
  params: CallModelParams,
  deferralFormReissued?: string,
  resumeTrimReissued?: string,
): CallModelStream {
  const turn = yield* prepareOpenaiTurn(params, deferralFormReissued, resumeTrimReissued)
  if (turn === undefined) return
  const { signal, tools, options, modelId, messages } = turn
  let attemptStartedAtMs = turn.turnStartedAtMs
  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS || turn.busy !== undefined; attempt++) {
    if (attempt > 1) {
      await refreshProviderUsage('openai', { force: true, reason: 'operator' })
      const refreshed = await resolveOpenaiRequestAuth({ sourceKind: turn.auth.account.kind })
      if (refreshed) turn.auth = refreshed
    }
    attemptStartedAtMs = Date.now()
    noteRunPhase('dispatch')
    const signInRequest = captureSignInRequest('openai', turn.auth.headers.authorization?.replace(/^Bearer /i, ''))
    const outcome = yield* streamOneOpenaiAttempt({
      request: turn.request,
      auth: turn.auth,
      signal,
      tools,
      options,
      modelId,
      messages,
      attempt,
      settlementNotes: turn.settlementNotes,
      ...(turn.effortAdjusted !== undefined ? { effortAdjusted: turn.effortAdjusted } : {}),
      effort: effortOnWire(turn),
      contractDigest: turn.contract.digest,
      deferredUnadmitted: turn.plan.isDeferredUnadmitted,
      ...(turn.busy !== undefined ? { busy: turn.busy } : {}),
    })
    if (outcome.kind === 'done') {
      await settleOpenaiTurn(turn, signInRequest, attemptStartedAtMs)
      return
    }
    if (outcome.kind === 'cancelled') return
    if (turn.request.prompt_cache_retention !== undefined && rejectOpenaiCacheRetention(modelId, outcome.fault)) {
      delete turn.request.prompt_cache_retention
      attempt--
      continue
    }
    observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.wireMessage ?? outcome.fault.message)
    const typed = openaiFaultToTypedError(outcome.fault)
    if (
      typed === 'authentication_failed' &&
      outcome.retryEligible &&
      turn.recovery === undefined &&
      attempt < OPENAI_MAX_ATTEMPTS
    ) {
      if (turn.auth.account.kind === 'chatgpt-subscription') {
        const fresh = await resolveOpenaiRequestAuth({
          sourceKind: 'chatgpt-subscription',
          forceRefresh: true,
        }).catch(() => undefined)
        if (signal.aborted) return
        if (fresh && fresh.headers.authorization !== turn.auth.headers.authorization) {
          turn.recovery = 'retried'
          turn.auth = fresh
          continue
        }
        turn.recovery = 'no-new-credential'
      } else if (configuredProviderKeyCommand('openai')) {
        const freshKey = recoverProviderKeyCommand('openai', turn.auth.headers.authorization?.replace(/^Bearer /i, ''))
        const fresh = freshKey ? await resolveOpenaiRequestAuth({ sourceKind: 'api-key' }).catch(() => undefined) : undefined
        if (signal.aborted) return
        if (fresh && fresh.headers.authorization !== turn.auth.headers.authorization) {
          turn.recovery = 'retried'
          turn.auth = fresh
          continue
        }
        turn.recovery = 'no-new-credential'
      }
    }
    const note = reissueTextForm(turn, outcome)
    if (note !== undefined) {
      yield* openaiTurn(params, note, resumeTrimReissued)
      return
    }
    const reissueAtServedWord = reissueAtServedEffort(turn, outcome, attempt)
    const refusedMedia = classifyImageRefusalFault(
      { status: outcome.fault.status, message: outcome.fault.wireMessage ?? outcome.fault.message },
      requestCarriesInputImage(turn.request),
    )
    const overflow = overflowOf(outcome.fault)
    const trimmed = trimResumedTranscript(turn, outcome, typed, reissueAtServedWord, refusedMedia, overflow)
    if (trimmed !== null) {
      yield* openaiTurn({ ...params, messages: trimmed.messages }, deferralFormReissued, trimmed.note)
      return
    }
    const askedMs = outcome.fault.retryAfterMs
    const wireDetail = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
    const singleShot = options.querySource === 'overload_probe'
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
        return
      }
      await sleep(step.waitMs, signal)
      if (signal.aborted) return
      attempt--
      continue
    }
    if (outcome.fault.status !== undefined) turn.reconnect = undefined
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
        if (signal.aborted) return
        continue
      }
      logForDebugging(`[openai] busy refusal (${wireDetail}) — the retry ladder is spent after ${ladder.waitsMs.length} retries and ${retrySeconds(ladder.spentMs)} of waiting`)
    }
    turn.emptyEnd = turn.busy === undefined && !singleShot && !reissueAtServedWord && outcome.retryEligible && isEmptyStreamFault(outcome.fault)
    if (turn.emptyEnd) {
      turn.emptyEnds++
      if (turn.emptyEnds < EMPTY_STREAM_TRIES) {
        const waitMs = emptyStreamRetryWaitMs()
        const notice = emptyStreamRetryNotice({ provider: 'OpenAI', detail: outcome.fault.code, attempt: turn.emptyEnds + 1, waitMs })
        logForDebugging(`[openai] ${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${turn.emptyEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
        yield notice
        options.onWait?.(retryNoticeWait(notice))
        await sleep(waitMs, signal)
        if (signal.aborted) return
        attempt--
        continue
      }
      logForDebugging(`[openai] ${emptyStreamSpentWords('OpenAI', Date.now() - turn.turnStartedAtMs)} (${wireDetail})`, { level: 'error' })
    }
    const retryable =
      !turn.emptyEnd &&
      !providerWaitIsWindow(askedMs) &&
      (reissueAtServedWord || (turn.busy === undefined && !singleShot && outcome.retryEligible && outcome.fault.retryable && attempt < OPENAI_MAX_ATTEMPTS))
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
      if (signal.aborted) return
      continue
    }
    const fault: AttemptFault = { outcome, typed, refusedMedia, overflow }
    if (outcome.fault.kind === 'usage-limit' && typed === 'rate_limit') {
      yield* refuseUsageLimit(turn, fault)
      return
    }
    yield* refuseTurn(turn, fault)
    return
  }
}
