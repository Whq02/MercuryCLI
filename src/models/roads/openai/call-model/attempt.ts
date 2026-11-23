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
import { streamCutForensicsDetail, streamCutForensicsLine } from '../streamCutForensics.js'
import type { Options } from '../../anthropic/streamCore.js'
import { noteRunPhase } from '../../../../platform/logs/runPhases.js'
import { emptyReplyChatText, emptyReplyNote, markEmptyReply, type EmptyReplyKind } from '../../emptyReply.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import { type EffortAdjustedV1 } from '../../../effort/effort.js'
import { streamIdleTimeoutMsForRoute, typedStreamEndOf } from '../../streamIdleBudget.js'
import { type BusyRetryLadder } from '../../busyRetry.js'
import { isTemporaryStreamFault } from '../../temporaryStreamError.js'
import {
  loadedToolNamesOf,
} from '../responsesBridge.js'
import { type EffortStampV1 } from '../../../effort/effortStamp.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import type {
  OpenaiCompletedToolCall,
  OpenaiFault,
  OpenaiInputItem,
  OpenaiResponsesRequest,
  OpenaiStreamEvent,
  OpenaiUsage,
} from '../openaiWire.js'
import { inputTransformationsLine } from '../openaiWire.js'
import type { RefusedToolCall } from '../../../../engine/message-shapes/message.js'
import { gateToolCalls, refusalAnswersAsToolResult, refusedCallInput, toolCallRefusalDiagnostic, toolCallRefusalNote } from '../../toolCallGate.js'
import { MODEL_NOT_FOUND_CODE, apiErrorMessage, overflowOf } from './faults.js'
import { openAttemptBlocks, streamEvent } from './attemptBlocks.js'
import { openAttemptEvents, settledFinishOf, type OpenaiSettledFinish } from './attemptEvents.js'
import { settleAttemptUsage } from './attemptSettle.js'

export type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: OpenaiFault; retryEligible: boolean }

export type OpenaiAttemptCtx = {
  _eventsForTesting?: AsyncIterable<OpenaiStreamEvent>
  request: OpenaiResponsesRequest
  auth: OpenaiRequestAuth
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  settlementNotes: readonly string[]
  effortAdjusted?: EffortAdjustedV1
  effort?: EffortStampV1
  contractDigest: string
  deferredUnadmitted?: (name: string) => boolean
  attempt?: number
  busy?: { ladder: BusyRetryLadder; fault: OpenaiFault }
}

export async function* streamOneOpenaiAttempt(ctx: OpenaiAttemptCtx): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { auth, signal, tools, modelId } = ctx
  const requestStartedAtMs = Date.now()
  const w = openAttemptBlocks(ctx)
  const { blocks, livePaintComplete, minted, mintBlock, ensureMessageStart, closeOpenBlock, streamDelta, emitSettledBlock, emitNoteBlock, emitLeadingNotes } = w
  let firstEventSeen = false
  let usageSeen: OpenaiUsage | undefined
  let responseId: string | undefined
  let refusalStreamed = false
  let finish: OpenaiSettledFinish | undefined
  let fault: OpenaiFault | undefined
  let settledOnFault: OpenaiInputItem[] = []

  const events = openAttemptEvents(ctx)
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
      noteRunPhase('first_byte')
    }
    switch (event.type) {
      case 'response-id':
        responseId = event.id
        break
      case 'reasoning-delta':
        yield* streamDelta('thinking', event.text)
        break
      case 'text-delta':
        yield* streamDelta('text', event.text)
        break
      case 'refusal-delta':
        refusalStreamed = true
        yield* streamDelta('text', event.text)
        break
      case 'text-item-start':
        if (blocks.open?.kind === 'text') yield* closeOpenBlock()
        w.pendingTextPhase = event.phase
        break
      case 'text-item-done':
        if (blocks.open?.kind === 'text') {
          if (event.phase && !blocks.open.phase) blocks.open.phase = event.phase
          yield* closeOpenBlock()
        }
        w.pendingTextPhase = undefined
        break
      case 'tool-args-start': {
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        yield* closeOpenBlock()
        blocks.index += 1
        blocks.open = {
          kind: 'tool',
          itemId: event.itemId,
          callId: event.callId,
          name: event.name,
          bytes: 0,
        }
        yield streamEvent({
          type: 'content_block_start',
          index: blocks.index,
          content_block: { type: 'tool_use', id: event.callId, name: event.name, input: {} },
        })
        break
      }
      case 'tool-args-delta': {
        if (blocks.open?.kind === 'tool' && blocks.open.itemId === event.itemId) {
          blocks.open.bytes += event.delta.length
          yield streamEvent({
            type: 'content_block_delta',
            index: blocks.index,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          })
        }
        break
      }
      case 'tool-args-done': {
        if (blocks.open?.kind === 'tool' && blocks.open.itemId === event.itemId) {
          if (blocks.open.bytes === 0 && event.argsRaw !== '') {
            yield streamEvent({
              type: 'content_block_delta',
              index: blocks.index,
              delta: { type: 'input_json_delta', partial_json: event.argsRaw },
            })
          }
          livePaintComplete.add(blocks.open.callId)
          yield* closeOpenBlock()
        }
        break
      }
      case 'usage':
        usageSeen = event.usage
        break
      case 'finish':
        finish = settledFinishOf(event)
        if (event.responseId && !responseId) responseId = event.responseId
        if (event.inputTransformations !== undefined) logForDebugging(inputTransformationsLine(modelId, event.inputTransformations))
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        if (event.settledItems !== undefined) settledOnFault = event.settledItems
        if (event.fault.forensics !== undefined) {
          logForDebugging(streamCutForensicsLine(auth.account.label, event.fault, event.fault.forensics), { level: 'warn' })
        }
        break
    }
  }

  if (fault?.kind === 'cancelled' || signal.aborted) {
    if (blocks.open?.kind === 'text' && blocks.open.value.length > 0) yield* closeOpenBlock()
    return { kind: 'cancelled' }
  }
  const nothingYielded = !w.messageStarted && minted.length === 0
  const retryTemporary = fault !== undefined && isTemporaryStreamFault(fault) && (finish?.toolCalls.length ?? 0) === 0
  if (fault && nothingYielded && (!finish || retryTemporary)) {
    return { kind: 'fault', fault, retryEligible: true }
  }
  const typedEnd =
    fault !== undefined && !finish && !retryTemporary && !MODEL_NOT_FOUND_CODE.test(fault.code)
      ? typedStreamEndOf({
          fault,
          provider: 'OpenAI',
          tailStands:
            blocks.open === null &&
            minted.at(-1)?.message.content[0]?.type === 'text' &&
            !settledOnFault.some(item => item.type === 'function_call'),
          silentMs: streamIdleTimeoutMsForRoute('openai'),
        })
      : null

  yield* ensureMessageStart()
  yield* closeOpenBlock()
  yield* emitLeadingNotes()

  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: OpenaiCompletedToolCall; input: Record<string, unknown> }> = []
  const refused: RefusedToolCall[] = []
  const answered: Array<{ call: OpenaiCompletedToolCall; refusal: RefusedToolCall }> = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.callId,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted, straightenQuotes: true },
  )
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
    else if (finish?.reason !== 'max_output_tokens' && refusalAnswersAsToolResult(verdict.refusal)) answered.push({ call, refusal: verdict.refusal })
    else refused.push(verdict.refusal)
  })
  for (const [index, call] of completed.entries()) {
    const verdict = verdicts[index]!
    const refusal = verdict.ok ? undefined : answered.find(entry => entry.call === call)?.refusal
    if (!verdict.ok && refusal === undefined) continue
    const input = verdict.ok ? verdict.input : refusedCallInput(refusal!)
    const decorate = refusal === undefined ? undefined : (message: AssistantMessage): void => {
      message.refusedToolCalls = [refusal]
    }
    if (refusal !== undefined) logForDebugging(`[openai] ${toolCallRefusalDiagnostic(refusal)}`, { level: 'warn' })
    if (livePaintComplete.has(call.callId)) {
      const m = mintBlock({
        type: 'tool_use',
        id: call.callId,
        name: call.name,
        input,
      })
      decorate?.(m)
      minted.push(m)
      yield m
      continue
    }
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.callId, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: verdict.ok ? call.argumentsRaw : JSON.stringify(input) }],
      { type: 'tool_use', id: call.callId, name: call.name, input: {} },
      decorate,
    )
  }
  for (const refusal of refused) {
    yield* emitNoteBlock(toolCallRefusalNote('openai', refusal), message => {
      message.refusedToolCalls = [refusal]
    })
  }
  if (finish && finish.webSearchCalls.length > 0) {
    for (const call of finish.webSearchCalls) {
      const block: ContentBlock = { type: 'server_tool_use', id: call.id, name: 'web_search', input: call.query !== undefined ? { query: call.query } : {} }
      yield* emitSettledBlock(block, [], block)
    }
    const lastCall = finish.webSearchCalls[finish.webSearchCalls.length - 1]!
    const resultBlock: ContentBlock = {
      type: 'web_search_tool_result',
      tool_use_id: lastCall.id,
      content: finish.citations.map(citation => ({ type: 'web_search_result', title: citation.title, url: citation.url })),
    }
    yield* emitSettledBlock(resultBlock, [], resultBlock)
  }
  if (finish?.refusalText && !refusalStreamed) yield* emitNoteBlock(finish.refusalText)
  if (finish?.reason === 'content_filter' && !refusalStreamed && !finish.refusalText) {
    yield* emitNoteBlock(
      '[openai] the provider ended this response under its content filter — the turn is incomplete by provider policy.',
    )
  }
  if (finish?.reason === 'other-incomplete') {
    yield* emitNoteBlock(
      `[openai] the provider ended this response INCOMPLETE (${finish.incompleteDetail ?? 'no reason stated'}) — the turn was cut short by the provider, not finished; continue or retry as needed.`,
    )
  }
  if (finish && finish.unknownItemTypes.length > 0) {
    yield* emitNoteBlock(
      `[openai] the provider returned output item types Mercury does not decode yet (${finish.unknownItemTypes.join(', ')}); recorded here.`,
    )
  }
  const loadedTools = finish ? loadedToolNamesOf(finish.orderedItems) : []
  if (loadedTools.length > 0) {
    logForDebugging(`[openai] tool search loaded ${loadedTools.length} deferred tool(s) server-side (${loadedTools.join(', ')}); the tools array is unchanged and the loaded definitions replay at the end of the input`)
  }
  if (minted.length === 0) {
    const emptyKind: EmptyReplyKind =
      finish?.reason === 'max_output_tokens'
        ? 'cap'
        : finish?.reason === 'completed' && finish.orderedItems.length > 0
          ? 'silence'
          : 'empty'
    const emptyNote = emptyReplyNote('openai', emptyKind, usageSeen?.reasoningOutputTokens)
    if (emptyKind === 'silence') logForDebugging(emptyNote)
    yield* emitNoteBlock(emptyReplyChatText(emptyKind, emptyNote), message => markEmptyReply(message, emptyKind, emptyNote))
  }

  const { stopReason, finalUsage } = settleAttemptUsage(ctx, minted, { usageSeen, responseId, refusalStreamed, finish, fault, settledOnFault, accepted, refused, answered }, requestStartedAtMs, typedEnd)
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && MODEL_NOT_FOUND_CODE.test(fault.code)) return { kind: 'fault', fault, retryEligible: false }
  if (fault && retryTemporary) return { kind: 'fault', fault, retryEligible: true }
  if (fault && typedEnd === null) {
    const faultRow = apiErrorMessage(
      streamFaultAfterPartialText(auth.account.label, fault.code, fault.message),
      undefined,
      fault.forensics === undefined ? undefined : streamCutForensicsDetail(fault, fault.forensics),
      overflowOf(fault),
    )
    yield ctx.effort !== undefined ? { ...faultRow, effort: ctx.effort } : faultRow
  }
  return { kind: 'done' }
}
