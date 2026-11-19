import '../../../utils/sessionStorage/writer.js'
import '../../run/resolveOwner.js'
import { llamacppOriginRefusal } from './compatRefusals.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import './compatToolSchemas.js'
import '../../../utils/cwd.js'
import '../../../utils/cache/cacheDomain.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { retryNoticeWait, retryReasonWords, requestWaitLine, streamReconnectSpentLine, streamReconnectWait } from '../streamIdleBudget.js'
import { providerWaitIsWindow, retrySeconds, stampProviderWait } from '../../api/recoveryBudget.js'
import { markUnknownModel } from '../../api/backupEngines.js'
import { NetworkOutageError, nextReconnect, openReconnectLadder, ReconnectBudgetSpentError, streamReconnectCause, type ReconnectLadder } from '../../api/reconnectLadder.js'
import { createSystemAPIErrorMessage } from '../../../utils/messages/systemMessages.js'
import { sleep } from '../../../utils/sleep.js'
import { busyRefusalFact, heldBusyRetryWait, nextBusyRetry, openBusyRetryLadder, takesBusyLadder, type BusyRetryLadder } from '../busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords, isEmptyStreamFault } from '../emptyStreamRetry.js'
import '../temporaryStreamError.js'
import '../../../utils/model/model.js'
import '../../api/overflowSignal.js'
import '../../api/outputFit.js'
import '../../api/emptyUsage.js'
import '../../api/promptCacheBreakDetection.js'
import '../anthropic/messageParams.js'
import '../../../utils/api.js'
import '../../../utils/messages.js'
import '../../../utils/effort.js'
import '../../../utils/model/utilityModel.js'
import '../../../utils/effortStamp.js'
import './compatWire.js'
import { replayKimiHistory } from './kimiReplay.js'
import '../openai/gptPins.js'
import '../../../utils/model/modelOverrides.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { classifyCredentialWall, credentialWallLine } from '../credentialWall.js'
import { logForDebugging } from '../../../utils/debug.js'
import { canonicalWireModelId } from '../routeLaw.js'
import '../../../prompt/behaviourContract.js'
import '../../../cost-tracker.js'
import '../../../utils/modelCost.js'
import '../faultUsageEstimate.js'
import { imageRefusalWords } from '../zai/zaiCodec.js'
import '../../../utils/model/capabilities.js'
import { noteImageRefusal } from '../../desktop/desktopSession.js'
import { compatImageRefusalWords, refreshCompatModelImageReading } from './compatProbe.js'
import {
  type CompatFault,
} from './compatChatClient.js'
import '../toolCallGate.js'
import '../localLiveness.js'
import '../local/toolCallMarkup.js'
import { localServerKind } from '../../../constants/localPromptProfile.js'
import '../local/toolDialect.js'
import '../toolEconomy.js'
import '../../desktop/screenshotRetention.js'
import '../../../utils/imageResizer.js'
import '../../../utils/messages/apiFilters.js'
import '../../../utils/messages/imageRequestFit.js'
import { compatDispatchModelId, type CompatCallModelParams, type CompatLaneId, type CompatLaneProfile } from './compatChatCallModel/lane.js'
import { apiErrorMessage, compatFaultToTypedError, compatTerminalFaultText, overflowOf } from './compatChatCallModel/faults.js'
import { openCompatTurn, prepareCompatTurn } from './compatChatCallModel/prepare.js'
import { streamOneCompatAttempt } from './compatChatCallModel/attempt.js'

export { compatDispatchModelId, imagesSupportedForCompatModel, laneExtrasWithOperatorEffort, type CompatCallModelParams, type CompatLaneProfile } from './compatChatCallModel/lane.js'
export { compatFaultToTypedError, compatTerminalFaultText } from './compatChatCallModel/faults.js'
export { mapCompatUsageToAnthropic } from './compatChatCallModel/attemptSettle.js'

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
  let busy: { ladder: BusyRetryLadder; fault: CompatFault } | undefined
  let reconnect: ReconnectLadder | undefined
  let emptyEnds = 0
  for (let attempt = 1; attempt <= COMPAT_MAX_ATTEMPTS || busy !== undefined; attempt++) {
    if (attempt > 1) {
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
      ...(leadingNotes.length ? { leadingNotes } : {}),
      ...(busy !== undefined ? { busy } : {}),
    })
    if (outcome.kind === 'done') {
      observeSignInResponse(signInRequest, 200)
      liveProof.set(profile.lane, { at: Date.now(), model: modelId })
      if (outcome.served !== undefined) profile.noteServedModel?.(modelId, outcome.served, credential)
      recordLaneTurnSettled(profile.lane)
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const laneClass = profile.classifyFault?.(outcome.fault)
    const typed = laneClass ?? compatFaultToTypedError(outcome.fault)
    const originRefusal = llamacppOriginRefusal(profile.dialect, outcome.fault)
    if ((laneClass === undefined || typed === 'authentication_failed') && !originRefusal) observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.message)
    if (
      typed === 'authentication_failed' &&
      !originRefusal &&
      outcome.retryEligible &&
      recovery === undefined &&
      profile.recoverCredential &&
      attempt < COMPAT_MAX_ATTEMPTS
    ) {
      const fresh = await profile.recoverCredential().catch(() => undefined)
      if (signal.aborted) return
      if (fresh?.apiKey !== undefined && fresh.apiKey !== credential.apiKey) {
        recovery = 'retried'
        credential = fresh
        continue
      }
      if (fresh !== null) recovery = 'no-new-credential'
    }
    const askedMs = outcome.fault.retryAfterMs
    const wireDetail = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
    const singleShot = options.querySource === 'overload_probe'
    const streamCut = outcome.retryEligible && !outcome.invisibleOnly && !singleShot ? streamReconnectCause(outcome.fault) : null
    if (streamCut !== null) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, streamCut)
      reconnect = ladder
      const step = nextReconnect(ladder, streamCut, now)
      if (step.waitMs <= 0) {
        try {
          const { logAPIDuration } = await import('../../api/logging.js')
          logAPIDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
        } catch {}
        yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${streamReconnectSpentLine(profile.providerLabel, outcome.fault.silentMs)}`, typed, 'stream-reconnect-spent'))
        return
      }
      const wait = streamReconnectWait(step.reconnect, step.of, step.waitMs, outcome.fault.silentMs)
      const notice = createSystemAPIErrorMessage(Object.assign(new Error(requestWaitLine(wait)), { streamWait: wait }), step.waitMs, step.reconnect, step.of)
      options.onWait?.(wait)
      yield notice
      await sleep(step.waitMs, signal)
      if (signal.aborted) { options.onWait?.(null); return }
      attempt--
      continue
    }
    const outage = outcome.retryEligible && !outcome.invisibleOnly && !singleShot ? outcome.fault.outage : undefined
    if (outage !== undefined) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, outage)
      reconnect = ladder
      const step = nextReconnect(ladder, outage, now)
      const notice = createSystemAPIErrorMessage(new NetworkOutageError(step, Object.assign(new Error(outcome.fault.message), { code: outage.code })), step.waitMs, step.reconnect, step.of)
      logForDebugging(`[compat:${profile.lane}] network outage (${wireDetail}) — ${notice.error.message}`)
      yield notice
      options.onWait?.({ kind: 'retry', attempt: step.reconnect, of: step.of, reason: retryReasonWords(undefined, notice.error.message), delayMs: step.waitMs, sinceMs: now })
      if (step.waitMs <= 0) {
        yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${new ReconnectBudgetSpentError(ladder, now, undefined).message}`, typed, outcome.fault.code))
        return
      }
      await sleep(step.waitMs, signal)
      if (signal.aborted) return
      attempt--
      continue
    }
    if (outcome.fault.status !== undefined) reconnect = undefined
    if (outcome.retryEligible && !outcome.invisibleOnly && !singleShot && takesBusyLadder(outcome.fault, typed) && !providerWaitIsWindow(askedMs)) {
      const ladder = busy?.ladder ?? openBusyRetryLadder(Date.now())
      busy = { ladder, fault: outcome.fault }
      const step = nextBusyRetry(ladder, askedMs, Date.now())
      if (step !== null) {
        logForDebugging(`[compat:${profile.lane}] busy refusal (${wireDetail}) — retry ${step.attempt} of ${step.of} after ${retrySeconds(step.waitMs)}${step.quiet ? ' inside the quiet window' : ''}`)
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
      logForDebugging(`[compat:${profile.lane}] busy refusal (${wireDetail}) — the retry ladder is spent after ${ladder.waitsMs.length} retries and ${retrySeconds(ladder.spentMs)} of waiting`)
    }
    const emptyEnd = busy === undefined && !singleShot && !outcome.invisibleOnly && outcome.retryEligible && isEmptyStreamFault(outcome.fault)
    if (emptyEnd) {
      emptyEnds++
      if (emptyEnds < EMPTY_STREAM_TRIES) {
        const waitMs = emptyStreamRetryWaitMs()
        const notice = emptyStreamRetryNotice({ provider: profile.providerLabel, detail: outcome.fault.code, attempt: emptyEnds + 1, waitMs })
        logForDebugging(`[compat:${profile.lane}] ${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${emptyEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
        yield notice
        options.onWait?.(retryNoticeWait(notice))
        await sleep(waitMs, signal)
        if (signal.aborted) return
        attempt--
        continue
      }
      logForDebugging(`[compat:${profile.lane}] ${emptyStreamSpentWords(profile.providerLabel, Date.now() - turnStartedAtMs)} (${wireDetail})`, { level: 'error' })
    }
    const retryable =
      !emptyEnd && busy === undefined && !singleShot && !providerWaitIsWindow(askedMs) && outcome.retryEligible && outcome.fault.retryable && attempt < COMPAT_MAX_ATTEMPTS
    if (retryable) {
      const delayMs = Math.max(COMPAT_RETRY_BACKOFF_MS * attempt, askedMs ?? 0)
      const notice = createSystemAPIErrorMessage(
        Object.assign(new Error(outcome.fault.message), {
          ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
          ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
        }),
        delayMs,
        attempt,
        COMPAT_MAX_ATTEMPTS - 1,
      )
      yield notice
      options.onWait?.(retryNoticeWait(notice))
      await sleep(delayMs, signal)
      if (signal.aborted) return
      continue
    }
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
      busy !== undefined && takesBusyLadder(outcome.fault, typed)
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
