import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../engine/requests/apiErrorRows.js'
import { classifyImageRefusalFault } from '../../../engine/request-parts/mediaRefusal.js'
import { createAssistantMessage } from '../../../engine/messages/messages.js'
import { normalizeModelStringForAPI } from '../../catalogue/engineModel.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiRequestAuth,
} from './openaiAccounts.js'
import { openaiLimitWindow } from './openaiLimitState.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { recordLaneBillingRefusal } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../signInRefusal.js'
import { rejectOpenaiCacheRetention } from './openaiCacheRetention.js'
import { busyRefusalFact } from '../busyRetry.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import {
  requestCarriesInputImage,
} from './responsesBridge.js'
import { MODEL_NOT_FOUND_CODE, apiErrorMessage, openaiFaultToTypedError, overflowOf } from './call-model/faults.js'
import { applyPrunedToolResults, prunedToolResultsByConversation, isFoldSource, priorConversation4xx, priorTurn4xxCodeOf } from './call-model/resumeTrim.js'
import { openOpenaiTurn, prepareOpenaiTurn, type TurnOpening } from './call-model/prepareTurn.js'
import { settleOpenaiTurn } from './call-model/turnSettled.js'
import { streamOneOpenaiAttempt } from './call-model/attempt.js'
import { reissueAtServedEffort, reissueTextForm, trimResumedTranscript } from './call-model/faultReissue.js'
import { refuseUsageLimit } from './call-model/faultRefusal.js'
import { busyPrefix, effortOnWire, withEffort, type AttemptFault } from './call-model/turnState.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

export { openaiLiveProofState } from './call-model/turnSettled.js'
export { effortVocabularyRefusalOf, openaiFaultToTypedError, openaiRetryDelayMs } from './call-model/faults.js'
export { toBridgeMessages } from './call-model/bridgeMessages.js'
export { buildProviderUsageReceipt, mapOpenaiUsageToAnthropic, replayableItems } from './call-model/attemptSettle.js'
export { imagesSupportedForLiveModel, imagesSupportedForModel, type ImagesSupportedSubject } from './call-model/images.js'
export { streamOneOpenaiAttempt } from './call-model/attempt.js'

export async function* openaiCallModel(params: CallModelParams): CallModelStream {
  yield* openaiTurn(params)
}

async function* openaiTurn(
  params: CallModelParams,
  deferralFormReissued?: string,
  resumeTrimReissued?: string,
): CallModelStream {
  const { systemPrompt, tools, signal, options } = params
  const requestedId = normalizeModelStringForAPI(options.model).trim().toLowerCase()
  const conversation4xxKey = `${getSessionId()}:${options.agentId ?? options.ownerKey ?? ''}:${params.messages[0]?.uuid ?? ''}`
  const messages = applyPrunedToolResults(params.messages, prunedToolResultsByConversation.get(conversation4xxKey))
  const prior4xxCode = priorTurn4xxCodeOf(messages, conversation4xxKey)

  const account = resolveOpenaiAccount()
  if (!account) {
    const failure = providerKeyCommandFailure('openai')
    const hint = failure ? `the configured ${failure.message} — no OpenAI account source is connected.` : 'no OpenAI account source is connected — /logins signs in to this account or attaches an API key.'
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${hint} Model '${requestedId}' cannot run.`,
    )
    return
  }
  if (openaiLimitWindow(account.kind).state === 'limited') await refreshProviderUsage('openai', { force: true, reason: 'operator' })
  const opening: TurnOpening = { params, deferralFormReissued, resumeTrimReissued, systemPrompt, tools, signal, options, requestedId, conversation4xxKey, messages, prior4xxCode, account }
  const prepared = await prepareOpenaiTurn(opening)
  if ('refusal' in prepared) {
    yield prepared.refusal
    return
  }
  const turn = openOpenaiTurn(opening, prepared)
  const { modelId, retries } = turn
  let attemptStartedAtMs = turn.turnStartedAtMs
  while (retries.next()) {
    if (retries.attempt > 1) {
      await refreshProviderUsage('openai', { force: true, reason: 'operator' })
      const refreshed = await resolveOpenaiRequestAuth({ sourceKind: turn.auth.account.kind, signal })
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
      attempt: retries.attempt,
      settlementNotes: turn.settlementNotes,
      ...(turn.effortAdjusted !== undefined ? { effortAdjusted: turn.effortAdjusted } : {}),
      effort: effortOnWire(turn),
      contractDigest: turn.contract.digest,
      deferredUnadmitted: turn.plan.isDeferredUnadmitted,
      ...(retries.busy !== undefined ? { busy: retries.busy } : {}),
    })
    if (outcome.kind === 'done') {
      await settleOpenaiTurn(turn, signInRequest, attemptStartedAtMs)
      return
    }
    if (outcome.kind === 'cancelled') return
    if (turn.request.prompt_cache_retention !== undefined && rejectOpenaiCacheRetention(modelId, outcome.fault)) {
      delete turn.request.prompt_cache_retention
      retries.uncounted()
      continue
    }
    observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.wireMessage ?? outcome.fault.message)
    const typed = openaiFaultToTypedError(outcome.fault)
    if (
      typed === 'authentication_failed' &&
      outcome.retryEligible &&
      turn.recovery === undefined &&
      retries.left
    ) {
      if (turn.auth.account.kind === 'chatgpt-subscription') {
        const fresh = await resolveOpenaiRequestAuth({
          sourceKind: 'chatgpt-subscription',
          forceRefresh: true,
          signal,
        }).catch(passedOverAs(undefined))
        if (signal.aborted) return
        if (fresh && fresh.headers.authorization !== turn.auth.headers.authorization) {
          turn.recovery = 'retried'
          turn.auth = fresh
          continue
        }
        turn.recovery = 'no-new-credential'
      } else if (configuredProviderKeyCommand('openai')) {
        const freshKey = recoverProviderKeyCommand('openai', turn.auth.headers.authorization?.replace(/^Bearer /i, ''))
        const fresh = freshKey ? await resolveOpenaiRequestAuth({ sourceKind: 'api-key' }).catch(passedOverAs(undefined)) : undefined
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
    const reissueAtServedWord = reissueAtServedEffort(turn, outcome, retries.attempt)
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
    const verdict = yield* retries.afterFault(outcome.fault, { typed, retryEligible: outcome.retryEligible, reissue: reissueAtServedWord })
    if (verdict.kind === 'again') continue
    if (verdict.kind === 'cancelled') return
    if (verdict.kind === 'outage-spent') {
      yield withEffort(turn, apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${verdict.line}`, typed, outcome.fault.code))
      return
    }
    const fault: AttemptFault = { outcome, typed, refusedMedia, overflow }
    if (outcome.fault.kind === 'usage-limit' && typed === 'rate_limit') {
      yield await refuseUsageLimit(turn, fault)
      return
    }
    const detail = outcome.fault.message
      ? `${outcome.fault.code}: ${outcome.fault.message}`
      : outcome.fault.code
    const text =
      typed === 'authentication_failed'
        ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI rejected the ${turn.auth.account.label} credential (${detail}) — ${
            turn.auth.account.kind === 'chatgpt-subscription'
              ? '/logins signs in to the ChatGPT account again'
              : 'set a valid OPENAI_API_KEY, or /logins attaches a fresh API key'
          }.${
            turn.recovery === 'retried'
              ? ' The stored token was refreshed and the call retried once before this refusal.'
              : turn.recovery === 'no-new-credential'
                ? ' A token refresh was attempted first and produced no new credential.'
                : ''
          }`
        : typed === 'billing_error'
          ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI reports the ${turn.auth.account.label} account out of credit (${detail}) — add credit to the OpenAI account, then retry; /model picks another model meanwhile.`
          : `${API_ERROR_MESSAGE_PREFIX}: OpenAI stream failed (${outcome.fault.code}) — ${outcome.fault.message}`
    if (typed === 'billing_error') {
      recordLaneBillingRefusal('openai', {
        detail,
        remedy: 'add credit to the OpenAI account, then retry; /model picks another model meanwhile.',
      })
    }
    if (typed === 'invalid_request' && refusedMedia === null && overflow === null && !MODEL_NOT_FOUND_CODE.test(outcome.fault.code) && !isFoldSource(options.querySource)) {
      priorConversation4xx.set(conversation4xxKey, outcome.fault.code)
    }
    if (resumeTrimReissued !== undefined) {
      yield withEffort(turn, createAssistantMessage({ content: resumeTrimReissued }))
    }
    yield withEffort(turn, apiErrorMessage(
      busyPrefix(turn, text, outcome.fault),
      typed,
      outcome.fault.code,
      overflow,
      refusedMedia,
      retries.busy !== undefined ? busyRefusalFact('OpenAI', retries.busy.ladder, outcome.fault) : null,
    ))
    return
  }
}
