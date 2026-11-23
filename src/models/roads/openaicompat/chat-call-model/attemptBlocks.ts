import { randomUUID } from 'crypto'
import type {
  ApiContentBlockDelta,
  ApiMessage,
  ApiStreamEvent,
  ContentBlock,
} from '../../../../engine/message-shapes/wire.js'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../engine/message-shapes/message.js'
import { busyRecoveryDetail } from '../../busyRetry.js'
import { EMPTY_USAGE } from '../../../../engine/request-parts/emptyUsage.js'
import {
  normalizeContentFromAPI,
} from '../../../../engine/messages/messages.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import { addToTotalSessionCost } from '../../../usage/sessionCost.js'
import { calculateUSDCost } from '../../../usage/modelCost.js'
import { estimateFaultedRequestUsage } from '../../faultUsageEstimate.js'
import {
  type CompatCompletedToolCall,
  type CompatFinishReason,
  type CompatUsage,
} from '../compatChatClient.js'
import type { RefusedToolCall } from '../../../../engine/message-shapes/message.js'
import { toolCallRefusalDiagnostic, toolCallRefusalNote } from '../../toolCallGate.js'
import { mapCompatUsageToAnthropic } from './attemptSettle.js'
import type { CompatAttemptCtx } from './attempt.js'

export const streamEvent = (event: ApiStreamEvent): StreamEvent => ({
  type: 'stream_event',
  event,
})

export type CompatAttemptFinish = {
  reason: CompatFinishReason
  rawReason: string
  toolCalls: CompatCompletedToolCall[]
}

export function openCompatBlocks(ctx: CompatAttemptCtx, requestStartedAtMs: number) {
  const { profile, request, tools, modelId } = ctx
  const partial: ApiMessage = {
    id: `${profile.lane}_${randomUUID()}`,
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
  const busyRecoveryStamp = (): AssistantMessage['busyRecovery'] => {
    if (ctx.busy === undefined || minted.length > 0) return undefined
    const { ladder, fault } = ctx.busy
    return {
      provider: profile.providerLabel,
      retries: ladder.waitsMs.length,
      elapsedMs: Date.now() - ladder.startedAtMs,
      ...(fault.status !== undefined ? { status: fault.status } : {}),
      code: fault.code,
      detail: busyRecoveryDetail({ provider: profile.providerLabel, status: fault.status, code: fault.code, message: fault.message, waitsMs: ladder.waitsMs }),
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
  let contentStarted = false
  let visibleTextStarted = false
  let toolFragmentSeen = false
  const blocks = {
    index: -1,
    allocated: -1,
    open: null as
      | { kind: 'thinking' | 'text'; value: string }
      | { kind: 'tool'; toolIndex: number }
      | null,
  }
  const nextBlockIndex = (): number => {
    blocks.allocated = Math.max(blocks.allocated, blocks.index) + 1
    return blocks.allocated
  }
  const toolPaints = new Map<number, { id: string; name: string; text: string; closed: boolean }>()
  const paintSlots: Array<{ toolIndex: number; id: string; at: number }> = []
  const minted: AssistantMessage[] = []
  let released = 0
  let usageSeen: CompatUsage | undefined
  let finish:
    | {
        reason: CompatFinishReason
        rawReason: string
        toolCalls: CompatCompletedToolCall[]
      }
    | undefined
  let streamedCharacters = 0
  let settledUsage: typeof EMPTY_USAGE | undefined
  const settleUsage = (faultCode?: string): typeof EMPTY_USAGE => {
    if (settledUsage !== undefined) return settledUsage
    const estimate = usageSeen === undefined && (contentStarted || toolFragmentSeen || finish !== undefined)
    settledUsage = estimate
      ? estimateFaultedRequestUsage({
          lane: profile.lane, model: modelId, request, faultCode: faultCode ?? 'usage-not-reported',
          minted: [{ message: { ...partial, content: [{ type: 'text', text: ' '.repeat(streamedCharacters), citations: null }] } }],
        })
      : mapCompatUsageToAnthropic(usageSeen)
    Object.assign(settledUsage, { request_started_at_ms: requestStartedAtMs })
    if (usageSeen !== undefined || estimate) {
      addToTotalSessionCost(
        usageSeen?.statedCostUSD ?? calculateUSDCost(modelId, settledUsage),
        settledUsage,
        modelId,
        usageSeen?.statedCostUSD !== undefined ? { basis: 'wire-stated' } : undefined,
      )
    }
    return settledUsage
  }
  function* ensureMessageStart(): Generator<StreamEvent> {
    if (messageStarted) return
    messageStarted = true
    yield streamEvent({ type: 'message_start', message: { ...partial, content: [] } })
  }
  function* releaseMinted(): Generator<AssistantMessage> {
    if (!visibleTextStarted && !toolFragmentSeen && !finish) return
    const limit = Math.min(minted.length - 1, paintSlots[0]?.at ?? minted.length)
    while (released < limit) yield minted[released++]!
  }
  function* pushMinted(message: AssistantMessage): Generator<AssistantMessage> {
    minted.push(message)
    yield* releaseMinted()
  }
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    if (blocks.open.kind === 'tool') {
      const paint = toolPaints.get(blocks.open.toolIndex)
      if (paint) paint.closed = true
      blocks.open = null
      yield streamEvent({ type: 'content_block_stop', index: blocks.index })
      return
    }
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : { type: 'text', text: blocks.open.value, citations: null }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    yield* pushMinted(mintBlock(settled))
  }
  function* openNewBlock(kind: 'thinking' | 'text'): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index = nextBlockIndex()
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
    blocks.index = nextBlockIndex()
    yield streamEvent({ type: 'content_block_start', index: blocks.index, content_block: startBlock })
    for (const delta of deltas) {
      yield streamEvent({ type: 'content_block_delta', index: blocks.index, delta })
    }
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(block)
    decorate?.(m)
    yield* pushMinted(m)
  }
  function refusalNoteMessage(refusal: RefusedToolCall): { note: string; decorate: (message: AssistantMessage) => void } {
    const note = toolCallRefusalNote(profile.lane, refusal)
    logForDebugging(`[compat:${profile.lane}] ${toolCallRefusalDiagnostic(refusal)}`, { level: 'warn' })
    return {
      note,
      decorate: message => {
        message.refusedToolCalls = [refusal]
      },
    }
  }
  let leadingNotesEmitted = false
  function* emitLeadingNotes(): Generator<StreamEvent | AssistantMessage> {
    if (leadingNotesEmitted) return
    leadingNotesEmitted = true
    for (const note of ctx.leadingNotes ?? []) {
      yield* emitSettledBlock(
        { type: 'text', text: note, citations: null },
        [{ type: 'text_delta', text: note }],
        { type: 'text', text: '', citations: null },
      )
    }
  }

  return {
    get messageStarted() { return messageStarted },
    get contentStarted() { return contentStarted },
    set contentStarted(value) { contentStarted = value },
    get visibleTextStarted() { return visibleTextStarted },
    set visibleTextStarted(value) { visibleTextStarted = value },
    get toolFragmentSeen() { return toolFragmentSeen },
    set toolFragmentSeen(value) { toolFragmentSeen = value },
    get released() { return released },
    set released(value) { released = value },
    get usageSeen() { return usageSeen },
    set usageSeen(value) { usageSeen = value },
    get finish() { return finish },
    set finish(value) { finish = value },
    get streamedCharacters() { return streamedCharacters },
    set streamedCharacters(value) { streamedCharacters = value },
    blocks,
    nextBlockIndex,
    toolPaints,
    paintSlots,
    minted,
    mintBlock,
    settleUsage,
    ensureMessageStart,
    releaseMinted,
    pushMinted,
    closeOpenBlock,
    openNewBlock,
    emitSettledBlock,
    refusalNoteMessage,
    emitLeadingNotes,
  }
}

export type AttemptBlocks = ReturnType<typeof openCompatBlocks>
