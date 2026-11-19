import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { classifyImageRefusalFault } from '../../api/mediaRefusal.js'
import { noteRunPhase } from '../../../utils/runPhases.js'
import {
  resolveOpenaiRequestAuth,
} from './openaiAccounts.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { configuredProviderKeyCommand, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { rejectOpenaiCacheRetention } from './openaiCacheRetention.js'
import {
  requestCarriesInputImage,
} from './responsesBridge.js'
import { OPENAI_MAX_ATTEMPTS, openaiFaultToTypedError, overflowOf } from './openaiCallModel/faults.js'
import { prepareOpenaiTurn } from './openaiCallModel/prepareTurn.js'
import { settleOpenaiTurn } from './openaiCallModel/turnSettled.js'
import { streamOneOpenaiAttempt } from './openaiCallModel/attempt.js'
import { reissueAtServedEffort, reissueTextForm, trimResumedTranscript } from './openaiCallModel/faultReissue.js'
import { retryOnFault } from './openaiCallModel/faultWait.js'
import { refuseTurn, refuseUsageLimit } from './openaiCallModel/faultRefusal.js'
import { effortOnWire, type AttemptFault } from './openaiCallModel/turnState.js'

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
    const fault: AttemptFault = { outcome, typed, attempt, reissueAtServedWord, refusedMedia, overflow, askedMs, wireDetail, singleShot }
    const retried = yield* retryOnFault(turn, fault)
    if (retried.kind === 'end') return
    if (retried.kind === 'again') attempt--
    if (retried.kind !== 'go_on') continue
    if (yield* refuseUsageLimit(turn, fault)) return
    yield* refuseTurn(turn, fault)
    return
  }
}
