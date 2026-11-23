import { randomUUID } from 'crypto'
import type {
  ApiContentBlockDelta,
  ApiMessage,
  ApiStreamEvent,
  ContentBlock,
  TextPhase,
} from '../../../../engine/message-shapes/wire.js'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../engine/message-shapes/message.js'
import { EMPTY_USAGE } from '../../../../engine/request-parts/emptyUsage.js'
import {
  normalizeContentFromAPI,
} from '../../../../engine/messages/messages.js'
import { busyRecoveryDetail } from '../../busyRetry.js'
import type { OpenaiAttemptCtx } from './attempt.js'

export const streamEvent = (event: ApiStreamEvent): StreamEvent => ({
  type: 'stream_event',
  event,
})

export function openAttemptBlocks(ctx: OpenaiAttemptCtx) {
  const { tools, modelId } = ctx
  const partial: ApiMessage = {
    id: `openai_${randomUUID()}`,
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
      provider: 'OpenAI',
      retries: ladder.waitsMs.length,
      elapsedMs: Date.now() - ladder.startedAtMs,
      ...(fault.status !== undefined ? { status: fault.status } : {}),
      code: fault.code,
      detail: busyRecoveryDetail({ provider: 'OpenAI', status: fault.status, code: fault.code, message: fault.message, waitsMs: ladder.waitsMs }),
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
  const blocks = {
    index: -1,
    open: null as
      | {
          kind: 'thinking' | 'text'
          value: string
          phase?: TextPhase
        }
      | {
          kind: 'tool'
          itemId: string
          callId: string
          name: string
          bytes: number
        }
      | null,
  }
  const livePaintComplete = new Set<string>()
  let pendingTextPhase: TextPhase | undefined
  const minted: AssistantMessage[] = []

  function* ensureMessageStart(): Generator<StreamEvent> {
    if (messageStarted) return
    messageStarted = true
    yield streamEvent({ type: 'message_start', message: { ...partial, content: [] } })
  }
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    if (blocks.open.kind === 'tool') {
      blocks.open = null
      yield streamEvent({ type: 'content_block_stop', index: blocks.index })
      return
    }
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : {
            type: 'text',
            text: blocks.open.value,
            citations: null,
            ...(blocks.open.phase ? { phase: blocks.open.phase } : {}),
          }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(settled)
    minted.push(m)
    yield m
  }
  function* openNewBlock(kind: 'thinking' | 'text'): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    const phase = kind === 'text' ? pendingTextPhase : undefined
    blocks.open = { kind, value: '', ...(phase ? { phase } : {}) }
    yield streamEvent({
      type: 'content_block_start',
      index: blocks.index,
      content_block:
        kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '', citations: null, ...(phase ? { phase } : {}) },
    })
  }
  function* streamDelta(kind: 'thinking' | 'text', text: string): Generator<StreamEvent | AssistantMessage> {
    yield* ensureMessageStart()
    yield* emitLeadingNotes()
    if (blocks.open?.kind !== kind) yield* openNewBlock(kind)
    const open = blocks.open!
    if (open.kind === kind) open.value += text
    yield streamEvent({
      type: 'content_block_delta',
      index: blocks.index,
      delta:
        kind === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text },
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
  function* emitNoteBlock(
    note: string,
    decorate?: (message: AssistantMessage) => void,
  ): Generator<StreamEvent | AssistantMessage> {
    yield* emitSettledBlock(
      { type: 'text', text: note, citations: null },
      [{ type: 'text_delta', text: note }],
      { type: 'text', text: '', citations: null },
      decorate,
    )
  }
  let leadingNotesEmitted = false
  function* emitLeadingNotes(): Generator<StreamEvent | AssistantMessage> {
    if (leadingNotesEmitted) return
    leadingNotesEmitted = true
    for (const note of ctx.settlementNotes) yield* emitNoteBlock(note)
  }

  return {
    get messageStarted(): boolean {
      return messageStarted
    },
    set pendingTextPhase(phase: TextPhase | undefined) {
      pendingTextPhase = phase
    },
    blocks,
    livePaintComplete,
    minted,
    mintBlock,
    ensureMessageStart,
    closeOpenBlock,
    streamDelta,
    emitSettledBlock,
    emitNoteBlock,
    emitLeadingNotes,
  }
}

