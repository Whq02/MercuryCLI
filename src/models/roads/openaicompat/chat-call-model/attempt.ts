import { settleTranscriptMessage } from '../../../../sessions/transcripts/writer.js'
import { randomUUID } from 'crypto'
import type {
  ContentBlock,
} from '../../../../engine/message-shapes/wire.js'
import type { Tools } from '../../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../../../../engine/message-shapes/message.js'
import { streamFaultAfterPartialText } from '../../../../engine/requests/apiErrorRows.js'
import { coldPrefixOf, estimateRequestTokens, streamIdleTimeoutMsForRoute, typedStreamEndOf } from '../../streamIdleBudget.js'
import { streamReconnectCause } from '../../../../engine/requests/reconnectLadder.js'
import { type BusyRetryLadder } from '../../busyRetry.js'
import { isTemporaryStreamFault } from '../../temporaryStreamError.js'
import type { Options } from '../../anthropic/streamCore.js'
import { EFFORT_STAMP_NONE, EFFORT_STAMP_THINKING_OFF, type EffortStampV1 } from '../../../effort/effortStamp.js'
import { isKimiK3WireModel, kimiReplayProjection } from '../kimiReplay.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import { type ApiShapedTool } from '../../zai/zaiCodec.js'
import {
  type CompatChatRequest,
  type CompatDeferralFacts,
  type CompatFault,
  type CompatRuntimeReading,
} from '../compatChatClient.js'
import { refusedCallInput } from '../../toolCallGate.js'
import { isLocalLivenessCut } from '../../localLiveness.js'
import { extractToolCallMarkup } from '../../local/toolCallMarkup.js'
import type { CompatLaneProfile } from './lane.js'
import { apiErrorMessage, compatFaultToTypedError, overflowOf } from './faults.js'
import { openCompatBlocks, streamEvent } from './attemptBlocks.js'
import { openCompatEvents } from './attemptEvents.js'
import { gateCompatToolCalls, paintedCallsOf, settleCompatUsage, terminationNoteOf } from './attemptSettle.js'

type AttemptOutcome =
  | { kind: 'done'; served?: string }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: CompatFault; retryEligible: boolean; invisibleOnly?: boolean; afterPartial?: true }

export type CompatAttemptCtx = {
  profile: CompatLaneProfile
  request: CompatChatRequest
  apiKey: string | undefined
  requestUrl: string
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  preparedMessages: Message[]
  deferredUnadmitted?: (name: string) => boolean
  callableTools?: readonly ApiShapedTool[]
  effort?: EffortStampV1
  imagesSupported: boolean
  servedByTensorFold: boolean
  deferral?: CompatDeferralFacts
  leadingNotes?: readonly string[]
  busy?: { ladder: BusyRetryLadder; fault: CompatFault }
}

export async function* streamOneCompatAttempt(ctx: CompatAttemptCtx): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { profile, request, requestUrl, signal, modelId } = ctx
  const requestStartedAtMs = Date.now()
  const w = openCompatBlocks(ctx, requestStartedAtMs)
  const { blocks, nextBlockIndex, toolPaints, paintSlots, minted, mintBlock, settleUsage, ensureMessageStart, releaseMinted, pushMinted, closeOpenBlock, openNewBlock, emitSettledBlock, refusalNoteMessage, emitLeadingNotes } = w

  let firstEventSeen = false
  const pendingToolFragments = new Map<number, string>()
  const preserveKimi = isKimiK3WireModel(request.model)
  let kimiReasoning: string | undefined
  let kimiContent = ''
  let runtimeSeen: CompatRuntimeReading | undefined
  let served: string | undefined
  let fault: CompatFault | undefined

  const extraHeaders = profile.extraHeaders?.()
  const idleTimeoutMs = streamIdleTimeoutMsForRoute(profile.lane, profile.dialect)
  const cold = coldPrefixOf(ctx.messages, modelId)
  const promptTokens = estimateRequestTokens(request)
  const prefillTokensPerSecond = await profile.prefillTokensPerSecond?.()
  if (signal.aborted) return { kind: 'cancelled' }
  const { transport, events } = openCompatEvents(ctx, extraHeaders, idleTimeoutMs, cold, promptTokens, prefillTokensPerSecond)
  try {
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
    }
    switch (event.type) {
      case 'served-model':
        served = event.model
        break
      case 'reasoning-delta': {
        w.streamedCharacters += event.text.length
        if (preserveKimi) kimiReasoning = (kimiReasoning ?? '') + event.text
        w.contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        if (blocks.open?.kind !== 'thinking') yield* openNewBlock('thinking')
        if (blocks.open?.kind === 'thinking') blocks.open.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
        break
      }
      case 'reasoning-withheld': {
        w.contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        const withheld: ContentBlock = { type: 'thinking', thinking: '', signature: event.signature }
        if (blocks.open?.kind === 'text') {
          const index = nextBlockIndex()
          yield streamEvent({ type: 'content_block_start', index, content_block: withheld })
          yield streamEvent({ type: 'content_block_stop', index })
          yield* pushMinted(mintBlock(withheld))
          break
        }
        yield* emitSettledBlock(withheld, [], withheld)
        break
      }
      case 'text-delta': {
        w.visibleTextStarted ||= event.text.trim().length > 0
        w.streamedCharacters += event.text.length
        if (preserveKimi) kimiContent += event.text
        w.contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        if (blocks.open?.kind !== 'text') yield* openNewBlock('text')
        if (blocks.open?.kind === 'text') blocks.open.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'text_delta', text: event.text },
        })
        break
      }
      case 'tool-call-fragment': {
        w.streamedCharacters += event.argumentsFragment.length
        w.toolFragmentSeen = true
        if (profile.lane === 'gemini') break
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        const paint = toolPaints.get(event.index)
        const id = event.id || paint?.id
        const name = event.name || paint?.name
        if (!id || !name) {
          if (event.argumentsFragment !== '') {
            pendingToolFragments.set(event.index, (pendingToolFragments.get(event.index) ?? '') + event.argumentsFragment)
          }
          break
        }
        if (paint !== undefined && (paint.closed || paint.id !== id)) {
          if (!paint.closed) yield* closeOpenBlock()
          break
        }
        if (paint === undefined) {
          yield* closeOpenBlock()
          blocks.index = nextBlockIndex()
          toolPaints.set(event.index, { id, name, text: '', closed: false })
          paintSlots.push({ toolIndex: event.index, id, at: minted.length })
          blocks.open = { kind: 'tool', toolIndex: event.index }
          yield streamEvent({
            type: 'content_block_start',
            index: blocks.index,
            content_block: { type: 'tool_use', id, name, input: {} },
          })
        }
        const record = toolPaints.get(event.index)!
        const piece = (pendingToolFragments.get(event.index) ?? '') + event.argumentsFragment
        pendingToolFragments.delete(event.index)
        if (piece !== '') {
          record.text += piece
          yield streamEvent({
            type: 'content_block_delta',
            index: blocks.index,
            delta: { type: 'input_json_delta', partial_json: piece },
          })
        }
        break
      }
      case 'usage':
        w.usageSeen = profile.usageForSettlement?.(event.usage) ?? event.usage
        break
      case 'runtime':
        runtimeSeen = event.runtime
        if (ctx.effort !== undefined && event.runtime.reasoningEffort !== undefined && ctx.effort.applied !== event.runtime.reasoningEffort && ctx.effort.wire !== EFFORT_STAMP_NONE) {
          ctx.effort.applied = event.runtime.thinking === false && event.runtime.reasoningEffort === 'none' ? EFFORT_STAMP_THINKING_OFF : event.runtime.reasoningEffort
        }
        break
      case 'finish':
        w.finish = {
          reason: event.reason,
          rawReason: event.rawReason,
          toolCalls: event.toolCalls,
        }
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        break
    }
  }

  if (fault?.kind === 'cancelled' || signal.aborted) {
    if (blocks.open?.kind === 'text' && blocks.open.value.length > 0) yield* closeOpenBlock()
    const finalUsage = settleUsage('cancelled')
    const lastMessage = minted.at(-1)
    if (lastMessage) lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    paintSlots.length = 0
    while (w.released < minted.length) yield minted[w.released++]!
    return { kind: 'cancelled' }
  }
  const hasTool = w.toolFragmentSeen || (w.finish?.toolCalls.length ?? 0) > 0
  if (fault && !w.finish && w.messageStarted && !w.visibleTextStarted && !hasTool) {
    if (blocks.open) yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    yield streamEvent({ type: 'message_stop' })
    return { kind: 'fault', fault, retryEligible: !isLocalLivenessCut(fault), invisibleOnly: true }
  }
  const nothingYielded = !w.contentStarted && minted.length === 0
  const retryStream = fault !== undefined && !w.finish && !hasTool && streamReconnectCause(fault) !== null
  const retryTemporary = fault !== undefined && isTemporaryStreamFault(fault) && !hasTool
  if (fault && nothingYielded && (!w.finish || retryTemporary)) {
    yield* closeOpenBlock()
    return { kind: 'fault', fault, retryEligible: !hasTool && !isLocalLivenessCut(fault) }
  }
  const typedEnd =
    fault !== undefined && !w.finish && !retryTemporary && !retryStream
      ? typedStreamEndOf({
          fault,
          provider: profile.providerLabel,
          tailStands: blocks.open === null && minted.at(-1)?.message.content[0]?.type === 'text',
          silentMs: streamIdleTimeoutMsForRoute(profile.lane),
        })
      : null

  yield* ensureMessageStart()
  let completed = w.finish?.toolCalls ?? []
  const readsMarkup = profile.lane === 'local' || ctx.servedByTensorFold
  if (readsMarkup && blocks.open !== null && blocks.open.kind !== 'tool' && w.finish !== undefined && (completed.length === 0 || (ctx.servedByTensorFold && blocks.open.kind === 'text'))) {
    const extracted = extractToolCallMarkup(blocks.open.value, ctx.callableTools ?? [])
    if (extracted !== undefined) {
      logForDebugging(`[compat:${profile.lane}] ${extracted.calls.length} tool call(s) read from ${extracted.shape} markup the server left in the ${blocks.open.kind}${completed.length > 0 ? ` beside ${completed.length} it parsed` : ''}`)
      completed = [...completed, ...extracted.calls.map((call, index) => ({ index: completed.length + index, id: `markup_${randomUUID().slice(0, 8)}_${index}`, name: call.name, argumentsRaw: call.argumentsRaw, malformed: false }))]
      if (extracted.text === '') {
        yield streamEvent({ type: 'content_block_stop', index: blocks.index })
        blocks.open = null
      } else {
        blocks.open.value = extracted.text
      }
    }
  }
  if (blocks.open?.kind === 'tool') {
    const open = blocks.open
    const paint = toolPaints.get(open.toolIndex)
    const call = paint === undefined ? undefined : completed.find(entry => entry.index === open.toolIndex && entry.id === paint.id)
    if (paint !== undefined && call !== undefined && call.argumentsRaw.length > paint.text.length && call.argumentsRaw.startsWith(paint.text)) {
      const tail = call.argumentsRaw.slice(paint.text.length)
      paint.text = call.argumentsRaw
      yield streamEvent({
        type: 'content_block_delta',
        index: blocks.index,
        delta: { type: 'input_json_delta', partial_json: tail },
      })
    }
  }
  yield* closeOpenBlock()
  if (completed.length > 0) yield* emitLeadingNotes()


  const { accepted, verdicts, answered } = gateCompatToolCalls(ctx, completed, w.finish)
  const paintedCalls = paintedCallsOf(w, completed, verdicts, answered)
  yield* releaseMinted()
  for (const [index, call] of completed.entries()) {
    const verdict = verdicts[index]!
    if (paintedCalls.has(call)) continue
    if (verdict.ok) {
      yield* emitSettledBlock(
        { type: 'tool_use', id: call.id, name: call.name, input: verdict.input },
        [{ type: 'input_json_delta', partial_json: call.argumentsRaw }],
        { type: 'tool_use', id: call.id, name: call.name, input: {} },
      )
      continue
    }
    const refusal = refusalNoteMessage(verdict.refusal)
    if (answered.has(call)) {
      const input = refusedCallInput(verdict.refusal)
      yield* emitSettledBlock(
        { type: 'tool_use', id: call.id, name: call.name, input },
        [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }],
        { type: 'tool_use', id: call.id, name: call.name, input: {} },
        refusal.decorate,
      )
      continue
    }
    yield* emitSettledBlock(
      { type: 'text', text: refusal.note, citations: null },
      [{ type: 'text_delta', text: refusal.note }],
      { type: 'text', text: '', citations: null },
      refusal.decorate,
    )
  }
  const terminationNote = retryTemporary ? undefined : terminationNoteOf(profile, w.finish)
  if (terminationNote !== undefined) {
    yield* emitSettledBlock(
      { type: 'text', text: terminationNote, citations: null },
      [{ type: 'text_delta', text: terminationNote }],
      { type: 'text', text: '', citations: null },
    )
  }
  if (minted.length === 0) {
    yield* emitSettledBlock(
      { type: 'text', text: '', citations: null },
      [],
      { type: 'text', text: '', citations: null },
    )
  }

  const { stopReason, finalUsage } = settleCompatUsage(ctx, settleUsage, { finish: w.finish, fault, usageSeen: w.usageSeen, runtimeSeen, served, accepted, answered })
  const lastMessage = minted.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    if (typedEnd !== null) lastMessage.streamEnd = typedEnd
    if (ctx.servedByTensorFold && typeof request.extra?.max_tokens === 'number') lastMessage.outputLimit = request.extra.max_tokens
    if (preserveKimi && !fault && w.finish && accepted.length === completed.length) {
      lastMessage.kimiProviderTurn = {
        model: request.model, endpoint: requestUrl,
        projection: kimiReplayProjection(minted.flatMap(message => message.message.content)),
        assistant: { role: 'assistant', content: kimiContent || (accepted.length ? null : ''), ...(kimiReasoning === undefined ? {} : { reasoning_content: kimiReasoning }), ...(accepted.length ? { tool_calls: accepted.map(({ call }) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsRaw } })) } : {}) },
      }
    }
    transport?.settle?.(minted)
    yield lastMessage
    void settleTranscriptMessage(lastMessage)
  }
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && profile.partialFaultPolicy === 'stop') return { kind: 'fault', fault, retryEligible: false }
  if (fault && (retryTemporary || retryStream)) return { kind: 'fault', fault, retryEligible: true, afterPartial: true }
  if (fault && typedEnd === null) {
    const faultRow = apiErrorMessage(
      streamFaultAfterPartialText(profile.providerLabel, fault.code, fault.message),
      profile.classifyFault?.(fault) ?? compatFaultToTypedError(fault),
      fault.code,
      overflowOf(profile, fault, { request, model: modelId }),
    )
    yield ctx.effort !== undefined ? { ...faultRow, effort: ctx.effort } : faultRow
  }
  return { kind: 'done', ...(served !== undefined ? { served } : {}) }
  } finally {
    settleUsage(fault?.code ?? (signal.aborted ? 'cancelled' : 'consumer-closed'))
  }
}
