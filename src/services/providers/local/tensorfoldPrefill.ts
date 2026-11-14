import { subscribeEngineModelOverride } from '../../../bootstrap/state.js'
import { flagEnabled } from '../../../substrate/flagRegistry.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { healWalkableForWire } from '../../../utils/messages.js'
import { getEngineModel } from '../../../utils/model/model.js'
import { isLoopbackUrl } from '../../../utils/privacyLevel.js'
import { tokenCountWithEstimation } from '../../../utils/tokens.js'
import { assistantMessageToMessageParam } from '../anthropic/messageParams.js'
import type { Options } from '../anthropic/streamCore.js'
import { streamCompatChat, type CompatChatRequest, type CompatStreamEvent, type CompatStreamOptions, type CompatWireMessage } from '../openaicompat/compatChatClient.js'
import { estimateRequestTokens, streamIdleTimeoutMsForRoute } from '../streamIdleBudget.js'
import { mapMessagesToZai } from '../zai/zaiCodec.js'
import { fetchTensorFold, type LocalModelRecord } from './localDiscovery.js'
import { onTensorFoldStopping } from './tensorfoldStopping.js'
import { tensorFoldTurnReadings } from './tensorfoldUsage.js'

export const NEXT_TURN_SETTLE_MS = 750
export const NEXT_TURN_STAGE_SECONDS = 5
export const NEXT_TURN_STAGE_FLOOR_TOKENS = 256
export const NEXT_TURN_LOOK_MS = 300
export const NEXT_TURN_SLOW_CUT_MS = 500
export const NEXT_TURN_SEED = 'ok'
const NEXT_TURN_LOOK_TIMEOUT_MS = 1000
const UNMEASURED_TOKENS_PER_SECOND = 300
const MEASURED_FLOOR_TOKENS = 256

type RequestOptions = Pick<Options, 'querySource' | 'agentId' | 'model'>

interface Offer {
  root: string
  model: string
  seated: string
  budgeted: boolean
  url: string
  apiKey?: string
  extraHeaders?: Record<string, string>
  imagesSupported?: boolean
  request: CompatChatRequest
  rows: CompatWireMessage[]
  from: number
  scale: number
  stages?: CompatWireMessage[][]
  next: number
}

interface PrefillIo {
  settleMs?: number
  lookMs?: number
  slowCutMs?: number
  tokensPerSecond?: number
}

export interface NextTurnPrefillFacts {
  offered: number
  started: number
  requests: number
  completed: number
  cut: number
  yielded: number
  slowed: number
  last: string | null
}

const state: {
  inFlight: Map<string, number>
  speed: Map<string, number>
  whole: Set<string>
  slow: Set<string>
  offer: Offer | null
  timer: ReturnType<typeof setTimeout> | null
  running: AbortController | null
  hooked: boolean
  io: PrefillIo
  facts: NextTurnPrefillFacts
} = {
  inFlight: new Map(),
  speed: new Map(),
  whole: new Set(),
  slow: new Set(),
  offer: null,
  timer: null,
  running: null,
  hooked: false,
  io: {},
  facts: { offered: 0, started: 0, requests: 0, completed: 0, cut: 0, yielded: 0, slowed: 0, last: null },
}

function note(words: string): void {
  state.facts.last = words
  logForDebugging(`[local-prefill] ${words}`)
}

function isMainConversation(options: RequestOptions): boolean {
  return options.agentId === undefined && (options.querySource === 'sdk' || options.querySource.startsWith('main_thread'))
}

export function nextTurnPrefillApplies(record: LocalModelRecord, options: RequestOptions): boolean {
  return (
    record.server === 'tensorfold' &&
    record.promptCache === true &&
    record.warmTurns === false &&
    isLoopbackUrl(record.baseUrl) &&
    isMainConversation(options) &&
    flagEnabled('MERCURY_LOCAL_NEXT_TURN_PREFILL')
  )
}

function stop(reason: string): boolean {
  if (state.timer !== null) clearTimeout(state.timer)
  state.timer = null
  const running = state.running
  if (running === null) return false
  state.running = null
  state.facts.cut += 1
  note(`cut short: ${reason}`)
  running.abort()
  return true
}

export function cancelNextTurnPrefill(reason: string): void {
  state.offer = null
  stop(reason)
}

function hook(): void {
  if (state.hooked) return
  state.hooked = true
  subscribeEngineModelOverride(() => {
    if (state.offer !== null && getEngineModel() !== state.offer.seated) cancelNextTurnPrefill('the model changed')
  })
  onTensorFoldStopping(port => {
    if (state.offer !== null && new URL(state.offer.root).port === String(port)) cancelNextTurnPrefill('the engine is being stopped')
  })
  registerCleanup(async () => cancelNextTurnPrefill('the session is ending'))
}

function foldPending(messages: readonly Message[], model: string): boolean {
  try {
    const { calculateTokenWarningState } = require('../../compact/autoCompact.js') as typeof import('../../compact/autoCompact.js')
    const level = calculateTokenWarningState(tokenCountWithEstimation(messages, model), model).level
    return level === 'compact' || level === 'blocked'
  } catch {
    return false
  }
}

function replyRows(minted: readonly AssistantMessage[], imagesSupported: boolean | undefined): CompatWireMessage[] {
  const settled = healWalkableForWire(minted).filter((message): message is AssistantMessage => message.type === 'assistant')
  return mapMessagesToZai(
    undefined,
    settled.map(message => assistantMessageToMessageParam(message, false, false)),
    { keepReasoningHistory: true, ...(imagesSupported !== undefined ? { imagesSupported } : {}) },
  ) as CompatWireMessage[]
}

function endsTheTurn(minted: readonly AssistantMessage[]): boolean {
  const last = minted.at(-1)
  return last !== undefined && last.isApiErrorMessage !== true && last.streamEnd === undefined && last.message.stop_reason === 'end_turn'
}

function offerNextTurn(record: LocalModelRecord, sent: CompatStreamOptions, minted: readonly AssistantMessage[], conversation: readonly Message[], options: RequestOptions): void {
  state.offer = null
  if (!endsTheTurn(minted) || state.slow.has(record.baseUrl)) return
  if (foldPending([...conversation, ...minted], options.model)) {
    note(`not read ahead: the conversation of ${record.id} is due a fold`)
    return
  }
  const sentRows = sent.request.messages
  const lastUser = sentRows.findLastIndex(row => !('tools' in row) && row.role === 'user')
  const counted = tensorFoldTurnReadings().findLast(row => row.model === record.id)?.promptTokens ?? 0
  const estimated = estimateRequestTokens({ messages: sentRows, ...(sent.request.tools !== undefined ? { tools: sent.request.tools } : {}) }, record.id)
  state.offer = {
    root: record.baseUrl,
    model: record.id,
    seated: getEngineModel(),
    budgeted: record.thinkingBudget === true || typeof sent.request.extra?.thinking_budget === 'number',
    url: sent.url,
    ...(sent.apiKey !== undefined ? { apiKey: sent.apiKey } : {}),
    ...(sent.extraHeaders !== undefined ? { extraHeaders: sent.extraHeaders } : {}),
    ...(sent.imagesSupported !== undefined ? { imagesSupported: sent.imagesSupported } : {}),
    request: sent.request,
    rows: [...sentRows, ...replyRows(minted, sent.imagesSupported)],
    from: lastUser + 1,
    scale: counted > 0 ? Math.min(3, Math.max(1 / 3, counted / estimated)) : 1,
    next: 0,
  }
  state.facts.offered += 1
  hook()
}

export function nextTurnStages(rows: readonly CompatWireMessage[], from: number, stageTokens: number, weigh: (row: CompatWireMessage) => number): CompatWireMessage[][] {
  const stages: CompatWireMessage[][] = []
  let since = 0
  for (let index = Math.max(0, from); index < rows.length - 1; index++) {
    const row = rows[index]!
    since += weigh(row)
    if (since >= stageTokens && !('tools' in row) && row.role === 'assistant') {
      stages.push(rows.slice(0, index + 1))
      since = 0
    }
  }
  stages.push([...rows])
  return stages
}

function tokensPerSecond(offer: Offer): number {
  if (state.io.tokensPerSecond !== undefined) return state.io.tokensPerSecond
  const measured = state.speed.get(offer.root)
  if (measured !== undefined) return measured
  const turn = tensorFoldTurnReadings().findLast(row => row.model === offer.model && row.prefillSeconds !== undefined && row.prefillSeconds > 0 && row.promptTokens - (row.cachedTokens ?? 0) >= MEASURED_FLOOR_TOKENS)
  return turn === undefined ? UNMEASURED_TOKENS_PER_SECOND : (turn.promptTokens - (turn.cachedTokens ?? 0)) / turn.prefillSeconds!
}

async function engineLoad(offer: Offer, signal: AbortSignal): Promise<{ connections: number; waiting: number } | undefined> {
  const answer = await fetchTensorFold(`${offer.root.replace(/\/v1\/?$/, '')}/health`, { timeoutMs: NEXT_TURN_LOOK_TIMEOUT_MS, signal })
  const live = (answer?.body as { live?: { connections?: unknown; waiting?: unknown } } | undefined)?.live
  return typeof live?.connections === 'number' && typeof live.waiting === 'number' ? { connections: live.connections, waiting: live.waiting } : undefined
}

function watchTheCut(offer: Offer): () => void {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    void engineLoad(offer, controller.signal).then(load => {
      if (controller.signal.aborted || load === undefined || load.waiting === 0) return
      state.slow.add(offer.root)
      state.facts.slowed += 1
      if (state.offer !== null && state.offer.root === offer.root) cancelNextTurnPrefill('the engine is slow to let a read-ahead go')
      note(`a request waited more than ${NEXT_TURN_SLOW_CUT_MS} ms behind a dropped read-ahead on ${offer.model}: nothing is read ahead on that engine again in this session`)
    })
  }, state.io.slowCutMs ?? NEXT_TURN_SLOW_CUT_MS)
  timer.unref?.()
  return () => {
    clearTimeout(timer)
    controller.abort()
  }
}

async function engineIdle(offer: Offer, signal: AbortSignal): Promise<boolean | undefined> {
  for (let look = 0; look < 2; look++) {
    if (look > 0) {
      await new Promise<void>(resolve => {
        const pause = setTimeout(resolve, state.io.lookMs ?? NEXT_TURN_LOOK_MS)
        pause.unref?.()
      })
    }
    if (signal.aborted) return false
    const load = await engineLoad(offer, signal)
    if (load === undefined) return undefined
    if (load.connections === 0) return true
  }
  return false
}

async function readAhead(offer: Offer, rows: readonly CompatWireMessage[], signal: AbortSignal): Promise<{ read: number; seconds?: number; fault?: string; refused: boolean; crowded: boolean }> {
  const request: CompatChatRequest = {
    ...offer.request,
    messages: [...rows, { role: 'user', content: NEXT_TURN_SEED }],
    extra: { ...offer.request.extra, priority: 'background', ...(offer.budgeted ? { max_tokens: 8, thinking_budget: 1 } : { max_tokens: 1 }) },
  }
  const own = new AbortController()
  const forward = (): void => own.abort()
  signal.addEventListener('abort', forward, { once: true })
  const options: CompatStreamOptions = {
    url: offer.url,
    ...(offer.apiKey !== undefined ? { apiKey: offer.apiKey } : {}),
    ...(offer.extraHeaders !== undefined ? { extraHeaders: offer.extraHeaders } : {}),
    ...(offer.imagesSupported !== undefined ? { imagesSupported: offer.imagesSupported } : {}),
    request,
    signal: own.signal,
    idleTimeoutMs: streamIdleTimeoutMsForRoute('local'),
    firstByte: { cold: true, promptTokens: estimateRequestTokens({ messages: rows.slice(offer.from) }, offer.model), model: offer.model },
  }
  let read = 0
  let seconds: number | undefined
  let fault: string | undefined
  let refused = false
  let crowded = false
  let looking = false
  const watch = setInterval(() => {
    if (looking || own.signal.aborted) return
    looking = true
    void engineLoad(offer, own.signal).then(load => {
      looking = false
      if (load === undefined || own.signal.aborted || (load.connections <= 1 && load.waiting === 0)) return
      crowded = true
      own.abort()
    })
  }, state.io.lookMs ?? NEXT_TURN_LOOK_MS)
  watch.unref?.()
  try {
    for await (const event of streamCompatChat(options) as AsyncIterable<CompatStreamEvent>) {
      if (event.type === 'usage') read = Math.max(0, event.usage.inputTokens - (event.usage.cachedInputTokens ?? 0))
      else if (event.type === 'runtime') seconds = event.runtime.prefillSeconds
      else if (event.type === 'stream-fault') {
        fault = fault ?? `${event.fault.code}: ${event.fault.message}`
        refused = refused || event.fault.status === 400 || event.fault.status === 422
      }
    }
  } catch (error) {
    if (!own.signal.aborted) throw error
  } finally {
    clearInterval(watch)
    signal.removeEventListener('abort', forward)
  }
  return { read, ...(seconds !== undefined ? { seconds } : {}), ...(fault !== undefined ? { fault } : {}), refused, crowded }
}

async function run(offer: Offer): Promise<void> {
  const controller = new AbortController()
  state.running = controller
  state.facts.started += 1
  const leave = (words: string): void => {
    if (state.offer === offer) state.offer = null
    note(words)
  }
  const startedAt = Date.now()
  let read = 0
  let sent = 0
  try {
    const stageTokens = Math.max(NEXT_TURN_STAGE_FLOOR_TOKENS, Math.round(tokensPerSecond(offer) * NEXT_TURN_STAGE_SECONDS))
    offer.stages ??= state.whole.has(offer.root) ? [offer.rows] : nextTurnStages(offer.rows, offer.from, stageTokens, row => estimateRequestTokens({ messages: [row] }, offer.model) * offer.scale)
    const stages = offer.stages
    while (offer.next < stages.length) {
      const idle = await engineIdle(offer, controller.signal)
      if (controller.signal.aborted) return
      if (idle === undefined) return leave(`the next turn of ${offer.model} is not read ahead: the engine does not show its load`)
      if (!idle) {
        state.facts.yielded += 1
        return leave(`the next turn of ${offer.model} is not read ahead: another request is on the engine`)
      }
      state.facts.requests += 1
      sent += 1
      const stage = await readAhead(offer, stages[offer.next]!, controller.signal)
      if (controller.signal.aborted) return
      if (stage.crowded) {
        state.facts.yielded += 1
        return leave(`the read-ahead of ${offer.model} made way for another request on the engine`)
      }
      if (stage.fault !== undefined) {
        if (!stage.refused || offer.next === stages.length - 1) return leave(`the next turn of ${offer.model} was not read ahead: ${stage.fault}`)
        state.whole.add(offer.root)
        offer.next = stages.length - 1
        continue
      }
      read += stage.read
      if (stage.seconds !== undefined && stage.seconds > 0 && stage.read >= MEASURED_FLOOR_TOKENS) state.speed.set(offer.root, stage.read / stage.seconds)
      offer.next += 1
    }
    if (state.offer === offer) state.offer = null
    state.facts.completed += 1
    note(`the next turn of ${offer.model} read ahead: ${read} tokens in ${Date.now() - startedAt} ms over ${sent} request(s)`)
  } catch (error) {
    if (!controller.signal.aborted) leave(`the next turn of ${offer.model} was not read ahead: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (state.running === controller) state.running = null
  }
}

function schedule(): void {
  if (state.timer !== null) clearTimeout(state.timer)
  const timer = setTimeout(() => {
    state.timer = null
    const offer = state.offer
    if (offer === null || state.running !== null) return
    if ((state.inFlight.get(offer.root) ?? 0) > 0) return
    if (!flagEnabled('MERCURY_LOCAL_NEXT_TURN_PREFILL')) return
    void run(offer)
  }, state.io.settleMs ?? NEXT_TURN_SETTLE_MS)
  timer.unref?.()
  state.timer = timer
}

export function tensorFoldRequestBegins(
  record: LocalModelRecord,
  conversation: readonly Message[],
  options: RequestOptions,
): { transport?: (sent: CompatStreamOptions) => { events: AsyncGenerator<CompatStreamEvent>; settle(minted: readonly AssistantMessage[]): void }; ends(): void } {
  const root = record.baseUrl
  let stopWatching: (() => void) | undefined
  if (state.offer !== null && state.offer.root === root) {
    const offer = state.offer
    if (stop('a request needs the engine')) stopWatching = watchTheCut(offer)
    if (isMainConversation(options) || options.querySource === 'compact') state.offer = null
  }
  state.inFlight.set(root, (state.inFlight.get(root) ?? 0) + 1)
  let ended = false
  const ends = (): void => {
    if (ended) return
    ended = true
    stopWatching?.()
    const left = (state.inFlight.get(root) ?? 1) - 1
    if (left > 0) state.inFlight.set(root, left)
    else state.inFlight.delete(root)
    if (left <= 0 && state.offer !== null && state.offer.root === root) schedule()
  }
  const canOffer = !state.slow.has(root) && nextTurnPrefillApplies(record, options)
  if (!canOffer && stopWatching === undefined) return { ends }
  return {
    ends,
    transport: sent => ({
      events: (async function* () {
        for await (const event of streamCompatChat(sent)) {
          stopWatching?.()
          yield event
        }
      })(),
      settle: minted => {
        if (!canOffer) return
        try {
          offerNextTurn(record, sent, minted, conversation, options)
        } catch (error) {
          note(`the next turn of ${record.id} was not composed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }),
  }
}

export function nextTurnPrefillFacts(): NextTurnPrefillFacts {
  return { ...state.facts }
}

export function __setNextTurnPrefillIoForTest(io: PrefillIo): void {
  state.io = io
}

export function __resetNextTurnPrefillForTest(): void {
  cancelNextTurnPrefill('reset')
  state.inFlight.clear()
  state.speed.clear()
  state.whole.clear()
  state.slow.clear()
  state.io = {}
  state.facts = { offered: 0, started: 0, requests: 0, completed: 0, cut: 0, yielded: 0, slowed: 0, last: null }
}
