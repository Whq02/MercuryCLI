import { llamacppOriginRefusal } from './compatRefusals.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../engine/message-shapes/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../engine/requests/apiErrorRows.js'
import { streamReconnectSpentLine } from '../streamIdleBudget.js'
import { retrySeconds, stampProviderWait } from '../../../engine/requests/recoveryBudget.js'
import { markUnknownModel } from '../../../engine/requests/backupEngines.js'
import { openTurnRetries } from '../../../engine/requests/withRetry.js'
import { busyRefusalFact, takesBusyLadder } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { replayKimiHistory } from './kimiReplay.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../signInRefusal.js'
import { classifyCredentialWall, credentialWallLine } from '../credentialWall.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { imageRefusalWords } from '../zai/zaiCodec.js'
import { noteImageRefusal } from '../../../integrations/desktop/desktopSession.js'
import { compatImageRefusalWords, refreshCompatModelImageReading } from './compatProbe.js'
import {
  type CompatFault,
} from './compatChatClient.js'
import { localServerKind } from '../localPromptProfile.js'
import { compatDispatchModelId, credentialNotes, type CompatCallModelParams, type CompatLaneId, type CompatLaneProfile } from './chat-call-model/lane.js'
import { apiErrorMessage, compatFaultToTypedError, compatTerminalFaultText, overflowOf } from './chat-call-model/faults.js'
import { openCompatTurn, prepareCompatTurn } from './chat-call-model/prepare.js'
import { streamOneCompatAttempt } from './chat-call-model/attempt.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'

export { compatDispatchModelId, imagesSupportedForCompatModel, laneExtrasWithOperatorEffort, type CompatCallModelParams, type CompatLaneProfile } from './chat-call-model/lane.js'
export { compatFaultToTypedError, compatTerminalFaultText } from './chat-call-model/faults.js'
export { mapCompatUsageToAnthropic } from './chat-call-model/attemptSettle.js'

const COMPAT_MAX_ATTEMPTS = 2
const COMPAT_RETRY_BACKOFF_MS = 400

const liveProof = new Map<CompatLaneId, { at: number; model: string }>()
export function compatLaneLiveProofState(lane: CompatLaneId): { at: number; model: string } | null {
  return liveProof.get(lane) ?? null
}

export async function* compatChatCallModel(
  profile: CompatLaneProfile,
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  if (signal.aborted) return
  const modelId = compatDispatchModelId(options.model)

  const wireVerdict = canonicalWireModelId(options.model)
  if (!wireVerdict.ok) {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${wireVerdict.reason}`)
    return
  }
  const hasImage = (message: Message): boolean => message.type === 'user' && Array.isArray(message.message.content) && message.message.content.some(block =>
    block.type === 'image' || block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(part => part.type === 'image'),
  )
  if (profile.lane === 'openai-compat' && messages.some(hasImage)) await refreshCompatModelImageReading(modelId, signal)
  if (signal.aborted) return
  const turnParams = { messages, systemPrompt, thinkingConfig, tools, options }
  const fitted = await prepareCompatTurn(profile, turnParams, modelId, hasImage)
  if ('refusal' in fitted) {
    yield fitted.refusal
    return
  }
  const prepared = openCompatTurn(profile, turnParams, modelId, fitted)
  if ('refusal' in prepared) {
    yield prepared.refusal
    return
  }
  let { credential } = prepared
  const { plan, callableTools, wireModel, imagesSupported, deferral, leadingNotes, toolsInPrompt, mappedMessages, preparedMessages, makeRequestExtra, request, effortOnWire, withEffort } = prepared

  const servedByTensorFold = localServerKind(modelId) === 'tensorfold'
  let recovery: 'retried' | 'no-new-credential' | undefined
  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  const retries = openTurnRetries<CompatFault>({
    signal,
    maxAttempts: COMPAT_MAX_ATTEMPTS,
    backoffMs: attempt => COMPAT_RETRY_BACKOFF_MS * attempt,
    provider: profile.providerLabel,
    log: `[compat:${profile.lane}]`,
    agent: options.agentId !== undefined,
    singleShot: options.querySource === 'overload_probe',
    streamReconnect: true,
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
  })
  while (retries.next()) {
    if (retries.attempt > 1) {
      if (profile.lane === 'openrouter' || profile.lane === 'huggingface' || profile.lane === 'gemini') {
        const { refreshProviderUsage } = await import('../providerUsage.js')
        await refreshProviderUsage(profile.lane, { force: true, reason: 'operator' })
      }
      const refreshed = await profile.resolveCredential()
      if (refreshed) credential = refreshed
      if (profile.dialect === 'llamacpp') {
        const slot = makeRequestExtra().id_slot
        if (typeof slot === 'number') request.extra = { ...request.extra, id_slot: slot, cache_prompt: true }
        else if (request.extra) { delete request.extra.id_slot; request.extra.cache_prompt = true }
      }
    }
    attemptStartedAtMs = Date.now()
    if (!toolsInPrompt) request.messages = replayKimiHistory(mappedMessages, preparedMessages, wireModel, credential.requestUrl ?? profile.requestUrl())
    const signInRequest = captureSignInRequest(profile.lane, credential.apiKey)
    const notes = [...leadingNotes, ...credentialNotes(credential, messages, options.querySource)]
    const outcome = yield* streamOneCompatAttempt({
      profile,
      request,
      apiKey: credential.apiKey,
      requestUrl: credential.requestUrl ?? profile.requestUrl(),
      signal,
      tools,
      options,
      modelId,
      messages,
      preparedMessages,
      deferredUnadmitted: plan.isDeferredUnadmitted,
      callableTools,
      effort: effortOnWire,
      imagesSupported,
      servedByTensorFold,
      ...(deferral !== undefined ? { deferral } : {}),
      ...(notes.length ? { leadingNotes: notes } : {}),
      ...(retries.busy !== undefined ? { busy: retries.busy } : {}),
    })
    if (outcome.kind === 'done') {
      observeSignInResponse(signInRequest, 200)
      liveProof.set(profile.lane, { at: Date.now(), model: modelId })
      if (outcome.served !== undefined) profile.noteServedModel?.(modelId, outcome.served, credential)
      recordLaneTurnSettled(profile.lane)
      try {
        const { logAPISuccessAndDuration } = await import('../../../engine/requests/apiCallLogging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch (error) {
        passedOver(error)
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const laneClass = profile.classifyFault?.(outcome.fault)
    const typed = laneClass ?? compatFaultToTypedError(outcome.fault)
    const originRefusal = llamacppOriginRefusal(profile.dialect, outcome.fault)
    const recordsRefusal = profile.recordsSignInRefusal?.(outcome.fault) ?? true
    if ((laneClass === undefined || typed === 'authentication_failed') && !originRefusal && recordsRefusal) observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.message)
    if (
      typed === 'authentication_failed' &&
      !originRefusal &&
      outcome.retryEligible &&
      recovery === undefined &&
      profile.recoverCredential &&
      retries.left
    ) {
      const fresh = await profile.recoverCredential().catch(passedOverAs(undefined))
      if (signal.aborted) return
      if (fresh?.apiKey !== undefined && fresh.apiKey !== credential.apiKey) {
        recovery = 'retried'
        credential = fresh
        continue
      }
      if (fresh !== null) recovery = 'no-new-credential'
    }
    const verdict = yield* retries.afterFault(outcome.fault, { typed, retryEligible: outcome.retryEligible, invisibleOnly: outcome.invisibleOnly === true })
    if (verdict.kind === 'again') {
      if (outcome.afterPartial === true) options.onStreamingFallback?.()
      continue
    }
    if (verdict.kind === 'cancelled') return
    if (verdict.kind === 'stream-reconnect-spent') {
      try {
        const { logAPIDuration } = await import('../../../engine/requests/apiCallLogging.js')
        logAPIDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch (error) { passedOver(error) }
      yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${streamReconnectSpentLine(profile.providerLabel, outcome.fault.silentMs)}`, typed, 'stream-reconnect-spent'))
      return
    }
    if (verdict.kind === 'outage-spent') {
      yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${verdict.line}`, typed, outcome.fault.code))
      return
    }
    const { busy, emptyEnd } = retries
    const wall = classifyCredentialWall(outcome.fault.status, outcome.fault.message, recovery !== undefined ? 'sign-in' : undefined)
    if (wall !== undefined && !originRefusal) {
      const wireSaid = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
      logForDebugging(`[compat:${profile.lane}] credential wall (${wall}) — the wire said: ${wireSaid}${recovery === 'retried' ? '; the stored token was refreshed and the call retried once first' : recovery === 'no-new-credential' ? '; a token refresh was attempted first and produced no new credential' : ''}`)
      const line = credentialWallLine(profile.lane, wall)
      if (wall === 'key-limit') recordLaneBillingRefusal(profile.lane, { detail: wireSaid, remedy: line })
      if (wall === 'sign-in') profile.onCredentialRefused?.(outcome.fault)
      yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${line}`, wall === 'key-limit' ? 'billing_error' : 'authentication_failed'))
      return
    }
    if (typed === 'authentication_failed') profile.onCredentialRefused?.(outcome.fault)
    if (typed === 'billing_error') {
      recordLaneBillingRefusal(profile.lane, {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.',
      })
    }
    const refusedImage = imageRefusalWords(request, { ...outcome.fault, message: outcome.fault.wireMessage ?? outcome.fault.message })
    if (refusedImage !== null) {
      noteImageRefusal(modelId, refusedImage)
      const serverRefusal = compatImageRefusalWords(modelId, refusedImage)
      yield withEffort(apiErrorMessage(
        serverRefusal !== null
          ? `${API_ERROR_MESSAGE_PREFIX}: ${serverRefusal} — the server refused the image: ${refusedImage}`
          : `${API_ERROR_MESSAGE_PREFIX}: the model on the ${profile.providerLabel} route refused the image: ${refusedImage} — the next request carries it as [image]; the Computer tool refuses on this model until /model picks one that receives images`,
        typed,
        outcome.fault.code,
        overflowOf(profile, outcome.fault, { request, model: modelId }),
        null,
        { blockTypes: ['image'], detail: refusedImage },
      ))
      return
    }
    const terminalText = compatTerminalFaultText(profile, outcome.fault, typed, { ...(recovery ? { recovery } : {}), requestUrl: credential.requestUrl ?? profile.requestUrl() }) + (profile.policyFaultNote?.(outcome.fault, request.extra) ?? '')
    const stayedBusy =
      busy !== undefined && takesBusyLadder(outcome.fault)
        ? `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stayed busy through ${busy.ladder.waitsMs.length} ${busy.ladder.waitsMs.length === 1 ? 'retry' : 'retries'} over ${retrySeconds(Date.now() - busy.ladder.startedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
        : emptyEnd
          ? `${API_ERROR_MESSAGE_PREFIX}: ${emptyStreamSpentWords(profile.providerLabel, Date.now() - turnStartedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
          : terminalText
    yield withEffort(stampProviderWait(
      markUnknownModel(apiErrorMessage(
        stayedBusy,
        typed,
        outcome.fault.code,
        overflowOf(profile, outcome.fault, { request, model: modelId }),
        busy !== undefined ? busyRefusalFact(profile.providerLabel, busy.ladder, outcome.fault) : null,
      ), outcome.fault.status),
      outcome.fault.retryAfterMs,
    ))
    return
  }
}
