import { processOwnerForLane } from '../../../run/resolveOwner.js'
import { streamCutForensicsLine } from '../streamCutForensics.js'
import { noteRunPhase } from '../../../../utils/runPhases.js'
import { streamOpenaiResponsesRoad } from '../openaiClient.js'
import { openaiSocketRoadChosen } from '../openaiSocketTransport.js'
import { coldPrefixOf, estimateRequestTokens, silentAfterHeadersWindowMs, streamIdleTimeoutMsForRoute } from '../../streamIdleBudget.js'
import { getPublicModelDisplayName } from '../../../../utils/model/model.js'
import { logForDebugging } from '../../../../utils/debug.js'
import type {
  OpenaiFault,
  OpenaiInputItem,
  OpenaiStreamEvent,
  OpenaiUsage,
} from '../openaiWire.js'
import { inputTransformationsLine } from '../openaiWire.js'
import { streamEvent, type AttemptBlocks } from './attemptBlocks.js'
import type { OpenaiAttemptCtx } from './attempt.js'

export type OpenaiSettledFinish = Pick<Extract<OpenaiStreamEvent, { type: 'finish' }>, 'reason' | 'toolCalls' | 'orderedItems' | 'refusalText' | 'unknownItemTypes' | 'webSearchCalls' | 'citations' | 'incompleteDetail'>

function settledFinishOf(event: Extract<OpenaiStreamEvent, { type: 'finish' }>): OpenaiSettledFinish {
  return {
    reason: event.reason,
    toolCalls: event.toolCalls,
    orderedItems: event.orderedItems,
    refusalText: event.refusalText,
    unknownItemTypes: event.unknownItemTypes,
    webSearchCalls: event.webSearchCalls ?? [],
    citations: event.citations ?? [],
    ...(event.incompleteDetail !== undefined
      ? { incompleteDetail: event.incompleteDetail }
      : {}),
  }
}

export function openAttemptEvents(ctx: OpenaiAttemptCtx): AsyncIterable<OpenaiStreamEvent> {
  const { request, auth, signal, options, modelId } = ctx
  const idleTimeoutMs = streamIdleTimeoutMsForRoute('openai')
  const cold = coldPrefixOf(ctx.messages, modelId)
  const promptTokens = estimateRequestTokens(request)
  const events =
    ctx._eventsForTesting ??
    streamOpenaiResponsesRoad({
      baseUrl: auth.baseUrl,
      headers: auth.headers,
      request,
      signal,
      ...(auth.account.kind === 'api-key' && openaiSocketRoadChosen()
        ? { socket: { owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) } }
        : {}),
      idleTimeoutMs,
      silentAfterHeadersMs: silentAfterHeadersWindowMs({ route: 'openai', cold, promptTokens, idleMs: idleTimeoutMs }),
      ...(options.onStreamActivity ? { onStreamActivity: options.onStreamActivity } : {}),
      firstByte: {
        cold,
        promptTokens,
        model: getPublicModelDisplayName(modelId) ?? modelId,
        ...(ctx.attempt !== undefined ? { attempt: ctx.attempt } : {}),
        ...(options.onWait ? { onWait: options.onWait } : {}),
      },
    })
  return events
}

export async function* readAttemptEvents(events: AsyncIterable<OpenaiStreamEvent>, w: AttemptBlocks, ctx: OpenaiAttemptCtx) {
  const { auth, modelId } = ctx
  const { blocks, livePaintComplete, ensureMessageStart, emitLeadingNotes, closeOpenBlock, streamDelta } = w
  let firstEventSeen = false
  let usageSeen: OpenaiUsage | undefined
  let responseId: string | undefined
  let refusalStreamed = false
  let finish: OpenaiSettledFinish | undefined
  let fault: OpenaiFault | undefined
  let settledOnFault: OpenaiInputItem[] = []
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
  return { usageSeen, responseId, refusalStreamed, finish, fault, settledOnFault }
}

export type AttemptRead = AsyncGeneratorReturn<ReturnType<typeof readAttemptEvents>>

type AsyncGeneratorReturn<G> = G extends AsyncGenerator<unknown, infer R, unknown> ? R : never
