import { settleTranscriptMessage } from '../../../sessions/transcripts/writer.js'
import { processOwnerForLane } from '../../../engine/run-owner/resolveOwner.js'
import { randomUUID } from 'crypto'
import type {
  ApiContentBlockDelta,
  ApiMessage,
  ApiStreamEvent,
  ContentBlock,
} from '../../../engine/message-shapes/wire.js'
import type { Tools } from '../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../../../engine/message-shapes/message.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX, streamFaultAfterPartialText } from '../../../engine/requests/apiErrorRows.js'
import { coldPrefixOf, estimateRequestTokens, silentAfterHeadersWindowMs, streamIdleTimeoutMsForRoute, typedStreamEndOf } from '../streamIdleBudget.js'
import { retrySeconds, stampProviderWait } from '../../../engine/requests/recoveryBudget.js'
import { markUnknownModel } from '../../../engine/requests/backupEngines.js'
import { openTurnRetries } from '../../../engine/requests/withRetry.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { busyRecoveryDetail, busyRefusalFact, takesBusyLadder, type BusyRetryLadder } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { getPublicModelDisplayName } from '../../catalogue/engineModel.js'
import { classifyOverflowFault, type OverflowSignal } from '../../../engine/requests/overflowSignal.js'
import { fitOutputTokensForRequest, outputFitWords } from '../../../engine/requests/outputFit.js'
import { EMPTY_USAGE } from '../../../engine/request-parts/emptyUsage.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
} from '../../../engine/requests/promptCacheBreakDetection.js'
import type { Options } from '../anthropic/streamCore.js'
import { toolToAPISchema } from '../../../engine/messages/apiSystemAndToolSchema.js'
import {
  healWalkableForWire,
  normalizeContentFromAPI,
} from '../../../engine/messages/messages.js'
import { resolveEffortTruth, resolveWireRequestedEffort } from '../../effort/effort.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../signInRefusal.js'
import { normalizeModelStringForAPI } from '../../catalogue/engineModel.js'
import { addToTotalSessionCost } from '../../usage/sessionCost.js'
import { calculateUSDCost } from '../../usage/modelCost.js'
import { estimateFaultedRequestUsage } from '../faultUsageEstimate.js'
import { resolveZaiDispatch } from './zaiAccounts.js'
import { learnZaiKeyPlan } from './zaiCatalogue.js'
import { otherZaiKeyPlan, rememberZaiKeyPlan, zaiKeyPlanUnknownWord, type ZaiKeyPlanWord } from './zaiKeyPlan.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { emptyReplyChatText, emptyReplyNote, markEmptyReply, type EmptyReplyKind } from '../emptyReply.js'
import {
  renderGenericInstructions,
  resolveBehaviourContract,
} from '../../../engine/system-prompt/behaviourContract.js'
import { imagesSupportedForCompatModel } from '../openaicompat/compatChatCallModel.js'
import { apiErrorMessage } from '../openaicompat/chat-call-model/faults.js'
import { toBridgeMessages } from '../openaicompat/chat-call-model/prepare.js'
import { noteImageRefusal } from '../../../integrations/desktop/desktopSession.js'
import { retireOlderScreenshots } from '../../../integrations/desktop/screenshotRetention.js'
import { fitImagesToRequestCap } from '../../../platform/images/imageResizer.js'
import { stripThinkingFromIndex } from '../../../engine/messages/apiFilters.js'
import {
  buildZaiChatRequest,
  imageRefusalWords,
  mapToolsToZai,
  toolDeclarationRowAsText,
  zaiEffortWireFact,
  type ApiShapedTool,
} from './zaiCodec.js'
import { effortStampOf, type EffortStampV1 } from '../../effort/effortStamp.js'
import {
  streamZaiChat,
  zaiChatCompletionsUrl,
  type ZaiCompletedToolCall,
  type ZaiFault,
  type ZaiFinishReason,
  type ZaiStreamEvent,
  type ZaiUsage,
  type ZaiWireMessage,
} from './zaiClient.js'
import type { RefusedToolCall } from '../../../engine/message-shapes/message.js'
import { gateToolCalls, refusalAnswersAsToolResult, refusedCallInput, toolCallRefusalNote } from '../toolCallGate.js'
import { planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'

const ZAI_MAX_OUTPUT_TOKENS = 131_072

let zaiLiveProof: { at: number; model: string } | null = null
export function zaiLiveProofState(): { at: number; model: string } | null {
  return zaiLiveProof
}
const ZAI_MAX_ATTEMPTS = 2
const ZAI_RETRY_BACKOFF_MS = 400

import { glmAcceptsEffort, glmEffortsFor, glmThinkingLocked } from '../../facts/pins/glmPins.js'
import { nearestSupportedWireEffort } from '../../facts/pins/gptPins.js'
import {
  compatFaultToTypedError,
  compatTerminalFaultText,
} from '../openaicompat/compatChatCallModel.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

function overflowOf(fault: Pick<ZaiFault, 'code' | 'message'> & { status?: number }): OverflowSignal | null {
  return classifyOverflowFault({ family: 'zai', status: fault.status, code: fault.code, message: fault.message })
}

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
  conversationKey?: string,
  pool: Tools = tools,
): Promise<ApiShapedTool[]> {
  const schemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: pool,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model,
        conversationKey,
      }),
    ),
  )
  const out: ApiShapedTool[] = []
  for (const schema of schemas) {
    const record = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof record.name === 'string' && record.input_schema !== undefined) {
      out.push({
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        input_schema: record.input_schema,
      })
    }
  }
  return out
}

export function mapZaiUsageToAnthropic(usage: ZaiUsage | undefined): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
  }
}

const FINISH_TO_STOP: Record<ZaiFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  sensitive: 'end_turn',
  model_context_window_exceeded: 'end_turn',
  network_error: 'end_turn',
  other: 'end_turn',
}

const ZAI_FAULT_PROFILE = {
  providerLabel: 'Z.AI',
  credentialHint: 'no Z.AI API key detected — /logins zai stores one (general or GLM Coding Plan); ZAI_API_KEY works too.',
  authRemedy:
    'set a valid ZAI_API_KEY (ZAI_KEY_PLAN=coding names a GLM Coding Plan key; unset, the plan is read from the key\'s own models list and both bases are asked), or store a new key via /logins zai (z.ai/manage-apikey issues them).',
  billingRemedy: 'top up the Z.AI account (its balance is exhausted), then retry; /model picks another model meanwhile.',
}

type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: ZaiFault; retryEligible: boolean; invisibleOnly?: boolean }

export async function* zaiCallModel(params: CallModelParams): CallModelStream {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  const modelId = normalizeModelStringForAPI(options.model)

  let dispatch = resolveZaiDispatch()
  if (!dispatch) {
    const failure = providerKeyCommandFailure('zai')
    const hint = failure ? `the configured ${failure.message} — no Z.AI API key detected.` : ZAI_FAULT_PROFILE.credentialHint
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${hint} Model '${modelId}' cannot run.`,
    )
    return
  }
  const planWord = dispatch.planSource === 'stored' ? undefined : zaiKeyPlanUnknownWord(hostEnv())
  if (planWord !== undefined) {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${planWord}. Model '${modelId}' cannot run.`)
    return
  }
  if (dispatch.planSource === 'assumed') {
    const learned = await learnZaiKeyPlan(dispatch.key)
    if (learned.plan !== undefined) dispatch = { ...dispatch, plan: learned.plan, planSource: 'learned' }
    else logForDebugging(`[zai] the plan of the ${dispatch.source} key could not be read from the models list (${learned.error.message}) — the general base is asked first`)
  }
  let apiKey = dispatch.key

  const plan = await planToolPayload({
    model: modelId,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    latchKey: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)),
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
  })
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId, plan.conversationKey)
  const toolDeclarations = new Map<string, ZaiWireMessage>()
  for (const declaration of plan.admissionDeclarations) {
    const shaped = await buildApiShapedTools(declaration.tools, options, modelId, plan.conversationKey, tools)
    if (shaped.length > 0) toolDeclarations.set(declaration.toolUseId, toolDeclarationRowAsText(mapToolsToZai(shaped)))
  }
  const wireMessages = renderAdmissionRecordsAsText(messages, plan.wireForm)
  const retiredScreenshots = retireOlderScreenshots(wireMessages, undefined, undefined, options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)))
  const retiredMessages =
    retiredScreenshots.firstEdited === -1
      ? retiredScreenshots.messages
      : stripThinkingFromIndex(retiredScreenshots.messages, retiredScreenshots.firstEdited)
  const fittedImages = await fitImagesToRequestCap(retiredMessages, { model: modelId, owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) })
  const wireMessagesForBridge =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)
  const effortContext = { agentId: options.agentId, pinned: options.effortPinned === true }
  const effortValue = resolveWireRequestedEffort(modelId, options.effortValue, effortContext)
  const effortTruth = resolveEffortTruth(modelId, options.effortValue, effortContext)
  const vocabulary = glmEffortsFor(modelId)
  const wireEffort =
    effortValue && vocabulary
      ? glmAcceptsEffort(modelId, effortValue)
        ? effortValue
        : nearestSupportedWireEffort(effortValue, [...vocabulary])
      : undefined
  const systemText = renderGenericInstructions(resolveBehaviourContract([...systemPrompt]))
  const zaiOutputFit = fitOutputTokensForRequest({
    asked: Math.min(options.maxOutputTokensOverride ?? ZAI_MAX_OUTPUT_TOKENS, ZAI_MAX_OUTPUT_TOKENS),
    messages,
    model: modelId,
    fixed: [systemText, apiTools],
  })
  if (zaiOutputFit.clamped) logForDebugging(outputFitWords(zaiOutputFit, modelId))
  const request = buildZaiChatRequest({
    model: modelId,
    system: systemText,
    messages: toBridgeMessages(healWalkableForWire(wireMessagesForBridge)),
    imagesSupported: imagesSupportedForCompatModel(modelId),
    tools: apiTools,
    ...(toolDeclarations.size > 0 ? { toolDeclarations } : {}),
    maxTokens: zaiOutputFit.tokens,
    ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
    thinkingEnabled: glmThinkingLocked(modelId) ? true : thinkingConfig.type !== 'disabled',
  })
  const effortOnWire: EffortStampV1 = effortStampOf(effortTruth.requested, zaiEffortWireFact(request, effortTruth.supportsEffort))
  const withEffort = (message: AssistantMessage): AssistantMessage => ({ ...message, effort: effortOnWire })

  recordPromptState({
    system: [{ text: systemText }],
    toolSchemas: apiTools,
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    ...(effortValue ? { effortValue } : {}),
    lane: 'zai',
    callReference: options.callReference,
  })

  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  let recovery: 'retried' | 'no-new-credential' | undefined
  let planTrial: { from: ZaiKeyPlanWord; fault: ZaiFault } | undefined
  const retries = openTurnRetries<ZaiFault>({
    signal,
    maxAttempts: ZAI_MAX_ATTEMPTS,
    backoffMs: attempt => ZAI_RETRY_BACKOFF_MS * attempt,
    provider: ZAI_FAULT_PROFILE.providerLabel,
    log: '[zai]',
    agent: options.agentId !== undefined,
    singleShot: options.querySource === 'overload_probe',
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
  })
  while (retries.next()) {
    attemptStartedAtMs = Date.now()
    const signInRequest = captureSignInRequest('zai', apiKey)
    let outcome = yield* streamOneZaiAttempt({
      request,
      apiKey,
      requestUrl: zaiChatCompletionsUrl(hostEnv(), dispatch.plan),
      signal,
      tools,
      options,
      modelId,
      messages,
      deferredUnadmitted: plan.isDeferredUnadmitted,
      effort: effortOnWire,
      ...(retries.busy !== undefined ? { busy: retries.busy } : {}),
    })
    if (outcome.kind === 'done') {
      observeSignInResponse(signInRequest, 200)
      if (dispatch.planSource === 'assumed' || dispatch.planSource === 'learned') rememberZaiKeyPlan(dispatch.key, dispatch.plan)
      zaiLiveProof = { at: Date.now(), model: modelId }
      recordLaneTurnSettled('zai')
      try {
        const { logAPISuccessAndDuration } = await import('../../../engine/requests/apiCallLogging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch (error) {
        passedOver(error)
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const refusedClass = (fault: ZaiFault): boolean => {
      const kind = compatFaultToTypedError(fault)
      return kind === 'authentication_failed' || kind === 'billing_error'
    }
    const otherBaseDiffers = zaiChatCompletionsUrl(hostEnv(), otherZaiKeyPlan(dispatch.plan)) !== zaiChatCompletionsUrl(hostEnv(), dispatch.plan)
    if (outcome.retryEligible && refusedClass(outcome.fault) && (dispatch.planSource === 'assumed' || dispatch.planSource === 'learned') && planTrial === undefined && otherBaseDiffers) {
      planTrial = { from: dispatch.plan, fault: outcome.fault }
      dispatch = { ...dispatch, plan: otherZaiKeyPlan(dispatch.plan), planSource: 'assumed' }
      logForDebugging(`[zai] the ${planTrial.from} base refused the ${dispatch.source} key (${outcome.fault.code}) — asking the ${dispatch.plan} base once before the fault is reported`)
      retries.uncounted()
      continue
    }
    if (planTrial !== undefined && refusedClass(outcome.fault)) {
      dispatch = { ...dispatch, plan: planTrial.from }
      outcome = { kind: 'fault', fault: planTrial.fault, retryEligible: outcome.retryEligible }
    }
    observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.message)
    const typed = compatFaultToTypedError(outcome.fault)
    if (
      typed === 'authentication_failed' &&
      outcome.retryEligible &&
      recovery === undefined &&
      configuredProviderKeyCommand('zai') &&
      retries.left
    ) {
      const fresh = recoverProviderKeyCommand('zai', apiKey)
      if (fresh) {
        recovery = 'retried'
        apiKey = fresh
        continue
      }
      recovery = 'no-new-credential'
    }
    const verdict = yield* retries.afterFault(outcome.fault, { typed, retryEligible: outcome.retryEligible, invisibleOnly: outcome.invisibleOnly === true })
    if (verdict.kind === 'again') continue
    if (verdict.kind === 'cancelled') return
    if (verdict.kind === 'outage-spent') {
      yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${verdict.line}`, typed, outcome.fault.code))
      return
    }
    const { busy, emptyEnd } = retries
    if (typed === 'billing_error') {
      recordLaneBillingRefusal('zai', {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: ZAI_FAULT_PROFILE.billingRemedy,
      })
    }
    const refusedImage = imageRefusalWords(request, outcome.fault)
    if (refusedImage !== null) {
      noteImageRefusal(modelId, refusedImage)
      yield withEffort(apiErrorMessage(
        `${API_ERROR_MESSAGE_PREFIX}: the model on the ${ZAI_FAULT_PROFILE.providerLabel} route refused the image: ${refusedImage} — the next request carries it as [image]; the Computer tool refuses on this model until /model picks one that receives images`,
        typed,
        outcome.fault.code,
        overflowOf(outcome.fault),
        null,
        { blockTypes: ['image'], detail: refusedImage },
      ))
      return
    }
    const terminalText = compatTerminalFaultText(ZAI_FAULT_PROFILE, outcome.fault, typed)
    const stayedBusy =
      busy !== undefined && takesBusyLadder(outcome.fault)
        ? `${API_ERROR_MESSAGE_PREFIX}: ${ZAI_FAULT_PROFILE.providerLabel} stayed busy through ${busy.ladder.waitsMs.length} ${busy.ladder.waitsMs.length === 1 ? 'retry' : 'retries'} over ${retrySeconds(Date.now() - busy.ladder.startedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
        : emptyEnd
          ? `${API_ERROR_MESSAGE_PREFIX}: ${emptyStreamSpentWords(ZAI_FAULT_PROFILE.providerLabel, Date.now() - turnStartedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
          : terminalText
    yield withEffort(stampProviderWait(
      markUnknownModel(apiErrorMessage(
        stayedBusy,
        typed,
        outcome.fault.code,
        overflowOf(outcome.fault),
        busy !== undefined ? busyRefusalFact(ZAI_FAULT_PROFILE.providerLabel, busy.ladder, outcome.fault) : null,
      ), outcome.fault.status),
      outcome.fault.retryAfterMs,
    ))
    return
  }
}

async function* streamOneZaiAttempt(ctx: {
  request: ReturnType<typeof buildZaiChatRequest>
  effort?: EffortStampV1
  apiKey: string
  requestUrl: string
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  deferredUnadmitted?: (name: string) => boolean
  busy?: { ladder: BusyRetryLadder; fault: ZaiFault }
}): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { request, apiKey, requestUrl, signal, tools, options, modelId } = ctx

  const w = openZaiAttemptBlocks(ctx)
  const { streamEvent, blocks, minted, mintBlock, ensureMessageStart, closeOpenBlock, openNewBlock, emitSettledBlock } = w
  let firstEventSeen = false
  let usageSeen: ZaiUsage | undefined
  let fault: ZaiFault | undefined

  const events = openZaiAttemptEvents(ctx, { request, apiKey, requestUrl, signal, options, modelId })
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
    }
    switch (event.type) {
      case 'reasoning-delta': {
        yield* ensureMessageStart()
        if (blocks.open?.kind !== 'thinking') yield* openNewBlock('thinking')
        blocks.open!.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
        break
      }
      case 'text-delta': {
        w.visibleTextStarted ||= event.text.trim().length > 0
        yield* ensureMessageStart()
        if (blocks.open?.kind !== 'text') yield* openNewBlock('text')
        blocks.open!.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'text_delta', text: event.text },
        })
        break
      }
      case 'tool-call-fragment':
        w.toolFragmentSeen = true
        break
      case 'usage':
        usageSeen = event.usage
        break
      case 'finish':
        w.finish = {
          reason: event.reason,
          rawReason: event.rawReason,
          toolCalls: event.toolCalls,
          stated: event.stated,
        }
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        break
    }
  }

  if (fault?.kind === 'cancelled' || signal.aborted) {
    if (blocks.open?.kind === 'text' && blocks.open.value.length > 0) yield* closeOpenBlock()
    return { kind: 'cancelled' }
  }
  if (fault && !w.finish && w.messageStarted && !w.visibleTextStarted && !w.toolFragmentSeen) {
    if (blocks.open) {
      const block = blocks.open.kind === 'thinking' ? { type: 'thinking' as const, thinking: blocks.open.value, signature: '' } : { type: 'text' as const, text: blocks.open.value, citations: null }
      minted.push(mintBlock(block))
      yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    }
    const usage = usageSeen ? mapZaiUsageToAnthropic(usageSeen) : estimateFaultedRequestUsage({ lane: 'zai', model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, usage), usage, modelId)
    yield streamEvent({ type: 'message_stop' })
    return { kind: 'fault', fault, retryEligible: true, invisibleOnly: true }
  }
  const nothingYielded = !w.messageStarted && minted.length === 0
  if (fault && nothingYielded && !w.finish && !w.toolFragmentSeen) {
    return { kind: 'fault', fault, retryEligible: true }
  }
  const typedEnd =
    fault !== undefined && !w.finish
      ? typedStreamEndOf({
          fault,
          provider: 'Z.AI',
          tailStands: blocks.open === null && minted.at(-1)?.message.content[0]?.type === 'text',
          silentMs: streamIdleTimeoutMsForRoute('zai'),
        })
      : null

  yield* ensureMessageStart()
  yield* closeOpenBlock()

  const { completed, accepted, refused, answered, verdicts } = gateZaiToolCalls(ctx, tools, w.finish)
  for (const [index, call] of completed.entries()) {
    const verdict = verdicts[index]!
    if (verdict.ok) {
      yield* emitSettledBlock(
        { type: 'tool_use', id: call.id, name: call.name, input: verdict.input },
        [{ type: 'input_json_delta', partial_json: call.argumentsRaw }],
        { type: 'tool_use', id: call.id, name: call.name, input: {} },
      )
      continue
    }
    const refusal = answered.find(entry => entry.call === call)?.refusal
    if (refusal === undefined) continue
    const input = refusedCallInput(refusal)
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.id, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }],
      { type: 'tool_use', id: call.id, name: call.name, input: {} },
      message => {
        message.refusedToolCalls = [refusal]
      },
    )
  }
  for (const refusal of refused) {
    const note = toolCallRefusalNote('zai', refusal)
    yield* emitSettledBlock(
      { type: 'text', text: note, citations: null },
      [{ type: 'text_delta', text: note }],
      { type: 'text', text: '', citations: null },
      message => {
        message.refusedToolCalls = [refusal]
      },
    )
  }
  const terminationNote = zaiTerminationNote(w.finish)
  if (terminationNote !== undefined) {
    yield* emitSettledBlock(
      { type: 'text', text: terminationNote, citations: null },
      [{ type: 'text_delta', text: terminationNote }],
      { type: 'text', text: '', citations: null },
    )
  }
  if (minted.length === 0) {
    const emptyKind: EmptyReplyKind =
      w.finish?.reason === 'length'
        ? 'cap'
        : w.finish?.reason === 'stop' && w.finish.stated
          ? 'silence'
          : 'empty'
    const note = emptyReplyNote('zai', emptyKind)
    if (emptyKind === 'silence') logForDebugging(note)
    const words = emptyReplyChatText(emptyKind, note)
    yield* emitSettledBlock(
      { type: 'text', text: words, citations: null },
      [{ type: 'text_delta', text: words }],
      { type: 'text', text: '', citations: null },
      message => markEmptyReply(message, emptyKind, note),
    )
  }

  const { stopReason, finalUsage } = settleZaiUsage(ctx, { finish: w.finish, accepted, answered, usageSeen, fault, typedEnd, minted, request, modelId, options })
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && typedEnd === null) {
    const faultRow = apiErrorMessage(
      streamFaultAfterPartialText('Z.AI', fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(fault),
    )
    yield ctx.effort !== undefined ? { ...faultRow, effort: ctx.effort } : faultRow
  }
  return { kind: 'done' }
}

type ZaiAttemptCtx = Parameters<typeof streamOneZaiAttempt>[0]

function openZaiAttemptBlocks(ctx: ZaiAttemptCtx) {
  const { tools, modelId } = ctx
  const partial: ApiMessage = {
    id: `zai_${randomUUID()}`,
    type: 'message' as const,
    role: 'assistant' as const,
    model: modelId,
    content: [] as ContentBlock[],
    stop_reason: null,
    stop_sequence: null as string | null,
    usage: { ...EMPTY_USAGE },
    container: null,
    context_management: null,
  }
  const streamEvent = (event: ApiStreamEvent): StreamEvent => ({
    type: 'stream_event',
    event,
  })
  const busyRecoveryStamp = (): AssistantMessage['busyRecovery'] => {
    if (ctx.busy === undefined || minted.length > 0) return undefined
    const { ladder, fault } = ctx.busy
    return {
      provider: ZAI_FAULT_PROFILE.providerLabel,
      retries: ladder.waitsMs.length,
      elapsedMs: Date.now() - ladder.startedAtMs,
      ...(fault.status !== undefined ? { status: fault.status } : {}),
      code: fault.code,
      detail: busyRecoveryDetail({ provider: ZAI_FAULT_PROFILE.providerLabel, status: fault.status, code: fault.code, message: fault.message, waitsMs: ladder.waitsMs }),
    }
  }
  const mintBlock = (block: ContentBlock): AssistantMessage => {
    const busyRecovery = busyRecoveryStamp()
    return {
      message: {
        ...partial,
        content: normalizeContentFromAPI([block], tools),
      } as AssistantMessage['message'],
      requestId: undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      ...(busyRecovery !== undefined ? { busyRecovery } : {}),
      ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
    }
  }

  let messageStarted = false
  let visibleTextStarted = false
  let toolFragmentSeen = false
  let released = 0
  const blocks = {
    index: -1,
    open: null as { kind: 'thinking' | 'text'; value: string } | null,
  }
  const minted: AssistantMessage[] = []
  let finish:
    | { reason: ZaiFinishReason; rawReason: string; toolCalls: ZaiCompletedToolCall[]; stated: boolean }
    | undefined

  function* ensureMessageStart(): Generator<StreamEvent> {
    if (messageStarted) return
    messageStarted = true
    yield streamEvent({ type: 'message_start', message: { ...partial, content: [] } })
  }
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : { type: 'text', text: blocks.open.value, citations: null }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(settled)
    minted.push(m)
    if (visibleTextStarted || toolFragmentSeen || finish) while (released < minted.length) yield minted[released++]!
  }
  function* openNewBlock(kind: 'thinking' | 'text'): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    blocks.open = { kind, value: '' }
    yield streamEvent({
      type: 'content_block_start',
      index: blocks.index,
      content_block:
        kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '', citations: null },
    })
  }
  function* emitSettledBlock(
    block: ContentBlock,
    deltas: ApiContentBlockDelta[],
    startBlock: ContentBlock,
    decorate?: (message: AssistantMessage) => void,
  ): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    yield streamEvent({ type: 'content_block_start', index: blocks.index, content_block: startBlock })
    for (const delta of deltas) {
      yield streamEvent({ type: 'content_block_delta', index: blocks.index, delta })
    }
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(block)
    decorate?.(m)
    minted.push(m)
    yield m
  }

  return {
    get messageStarted(): boolean {
      return messageStarted
    },
    get visibleTextStarted(): boolean {
      return visibleTextStarted
    },
    set visibleTextStarted(started: boolean) {
      visibleTextStarted = started
    },
    get toolFragmentSeen(): boolean {
      return toolFragmentSeen
    },
    set toolFragmentSeen(seen: boolean) {
      toolFragmentSeen = seen
    },
    get finish(): typeof finish {
      return finish
    },
    set finish(settled: typeof finish) {
      finish = settled
    },
    streamEvent,
    blocks,
    minted,
    mintBlock,
    ensureMessageStart,
    closeOpenBlock,
    openNewBlock,
    emitSettledBlock,
  }
}

type ZaiAttemptBlocks = ReturnType<typeof openZaiAttemptBlocks>

function openZaiAttemptEvents(
  ctx: ZaiAttemptCtx,
  { request, apiKey, requestUrl, signal, options, modelId }: Pick<ZaiAttemptCtx, 'request' | 'apiKey' | 'requestUrl' | 'signal' | 'options' | 'modelId'>,
) {
  const idleTimeoutMs = streamIdleTimeoutMsForRoute('zai')
  const cold = coldPrefixOf(ctx.messages, modelId)
  const promptTokens = estimateRequestTokens(request)
  const events: AsyncGenerator<ZaiStreamEvent> = streamZaiChat({
    apiKey,
    request,
    signal,
    baseUrl: requestUrl,
    idleTimeoutMs,
    silentAfterHeadersMs: silentAfterHeadersWindowMs({ route: 'zai', cold, promptTokens, idleMs: idleTimeoutMs }),
    ...(options.onStreamActivity ? { onStreamActivity: options.onStreamActivity } : {}),
    firstByte: {
      cold,
      promptTokens,
      model: getPublicModelDisplayName(modelId) ?? modelId,
      ...(options.onWait ? { onWait: options.onWait } : {}),
    },
  })
  return events
}

function gateZaiToolCalls(ctx: ZaiAttemptCtx, tools: Tools, finish: ZaiAttemptBlocks['finish']) {
  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: ZaiCompletedToolCall; input: Record<string, unknown> }> = []
  const refused: RefusedToolCall[] = []
  const answered: Array<{ call: ZaiCompletedToolCall; refusal: RefusedToolCall }> = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.id,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted },
  )
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
    else if (finish?.reason !== 'length' && refusalAnswersAsToolResult(verdict.refusal)) answered.push({ call, refusal: verdict.refusal })
    else refused.push(verdict.refusal)
  })
  return { completed, accepted, refused, answered, verdicts }
}

function zaiTerminationNote(finish: ZaiAttemptBlocks['finish']): string | undefined {
  switch (finish?.reason) {
    case 'sensitive':
      return `[zai] the provider ended this response under its content policy ('sensitive') — the turn is incomplete by provider policy, not finished.`
    case 'model_context_window_exceeded':
      return `[zai] the provider ended this response: the request exceeded the model's context window — the turn was cut short; compact or trim the conversation, then retry.`
    case 'network_error':
      return `[zai] the provider ended this response: a provider-side network error (a documented transient) — the turn was cut short, not finished; continue or retry as needed.`
    case 'other':
      return `[zai] the provider ended this response with an unmapped finish reason ('${finish?.rawReason ?? 'none stated'}') — the turn may be incomplete; continue or retry as needed.`
    default:
      return undefined
  }
}

function settleZaiUsage(
  ctx: ZaiAttemptCtx,
  { finish, accepted, answered, usageSeen, fault, typedEnd, minted, request, modelId, options }: {
    finish: ZaiAttemptBlocks['finish']
    accepted: ReturnType<typeof gateZaiToolCalls>['accepted']
    answered: ReturnType<typeof gateZaiToolCalls>['answered']
    usageSeen: ZaiUsage | undefined
    fault: ZaiFault | undefined
    typedEnd: ReturnType<typeof typedStreamEndOf> | null
    minted: AssistantMessage[]
  } & Pick<ZaiAttemptCtx, 'request' | 'modelId' | 'options'>,
) {
  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'stop'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 || answered.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapZaiUsageToAnthropic(usageSeen)
  if (!usageSeen && fault !== undefined) {
    const estimated = estimateFaultedRequestUsage({ lane: 'zai', model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    addToTotalSessionCost(
      calculateUSDCost(modelId, finalUsage),
      finalUsage,
      modelId,
    )
  }
  if (usageSeen) {
    void checkResponseForCacheBreak(
      options.querySource,
      finalUsage.cache_read_input_tokens,
      finalUsage.cache_creation_input_tokens ?? 0,
      ctx.messages,
      options.agentId,
      null,
    )
  }
  const lastMessage = minted.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    if (typedEnd !== null) lastMessage.streamEnd = typedEnd
    void settleTranscriptMessage(lastMessage)
  }
  return { stopReason, finalUsage } as const
}
