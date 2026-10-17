import { createHash } from 'node:crypto'
import { logForDebugging } from '../../../utils/debug.js'
import { getUserAgent } from '../../../utils/http.js'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../../utils/proxy.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import {
  createStreamIdleWatchdog,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  type RequestWaitV1,
  StreamIdleTimeoutError,
  streamIdleFaultWords,
  streamIdleTimeoutMs,
} from '../streamIdleBudget.js'
import { ResponsesStreamFold, type OpenaiInputItem, type OpenaiResponsesRequest, type OpenaiStreamEvent } from './openaiWire.js'

export const SOCKET_CONNECT_TIMEOUT_MS = 15_000
export const SOCKET_ROTATION_MS = 55 * 60_000
export const SOCKET_IDLE_CLOSE_MS = 30 * 60_000
export const SOCKET_FAULTS_BEFORE_REST = 3
export const SOCKET_REST_MS = 10 * 60_000
export const SOCKET_MESSAGE_TOO_LARGE_CLOSE = 1009

export type OpenaiTransportChoice = NonNullable<NonNullable<SettingsJson['routing']>['openai']>['transport']

export function openaiSocketRoadChosen(settings: SettingsJson = getInitialSettings()): boolean {
  return settings.routing?.openai?.transport === 'websocket'
}

export function responsesSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '').replace(/^http/i, 'ws')}/responses`
}

export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  readyState?: number
  addEventListener?(event: string, handler: (event: never) => void): void
  on?(event: string, handler: (...args: never[]) => void): void
}

export type SocketOpener = (url: string, headers: Record<string, string>) => SocketLike | Promise<SocketLike>

type Frame = { kind: 'message'; text: string } | { kind: 'close'; code?: number; reason?: string } | { kind: 'error'; message: string }

type HeldSocket = {
  key: string
  socket: SocketLike
  openedAtMs: number
  lastResponseId: string | undefined
  heldInput: OpenaiInputItem[] | null
  inFlight: boolean
  closed: boolean
  queue: Frame[]
  waiter: ((frame: Frame) => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

type RoadLedger = { faults: number; restUntilMs: number; opened: number; fellBack: number; chained: number; replayedWhole: number }

const held = new Map<string, HeldSocket>()
const ledgers = new Map<string, RoadLedger>()

function ledgerOf(key: string): RoadLedger {
  let ledger = ledgers.get(key)
  if (ledger === undefined) {
    ledger = { faults: 0, restUntilMs: 0, opened: 0, fellBack: 0, chained: 0, replayedWhole: 0 }
    ledgers.set(key, ledger)
  }
  return ledger
}

export function openaiSocketRoadLedger(key: string): Readonly<RoadLedger> {
  return { ...ledgerOf(key) }
}

export function socketRoadKey(baseUrl: string, headers: Record<string, string>, owner: string): string {
  const auth = headers.authorization ?? headers.Authorization ?? ''
  const digest = createHash('sha256').update(auth).digest('hex').slice(0, 16)
  return `${baseUrl}|${digest}|${owner}`
}

let openerOverride: SocketOpener | undefined

export function _ageOpenaiSocketsForTest(ms: number): void {
  for (const entry of held.values()) entry.openedAtMs -= ms
}

export function _resetOpenaiSocketRoadForTest(opener?: SocketOpener): void {
  for (const entry of held.values()) dropHeld(entry)
  held.clear()
  ledgers.clear()
  openerOverride = opener
}

function dropHeld(entry: HeldSocket): void {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  entry.idleTimer = null
  entry.closed = true
  try {
    entry.socket.close()
  } catch {
    entry.closed = true
  }
  if (held.get(entry.key) === entry) held.delete(entry.key)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>
      return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, k) => {
        if (record[k] !== undefined) acc[k] = record[k]
        return acc
      }, {})
    }
    return inner
  })
}

export function incrementalInput(heldInput: readonly OpenaiInputItem[] | null, nextInput: readonly OpenaiInputItem[]): OpenaiInputItem[] | null {
  if (heldInput === null || heldInput.length === 0 || nextInput.length <= heldInput.length) return null
  for (let index = 0; index < heldInput.length; index++) {
    if (canonical(heldInput[index]) !== canonical(nextInput[index])) return null
  }
  return nextInput.slice(heldInput.length)
}

async function openSocket(url: string, headers: Record<string, string>, opener: SocketOpener | undefined = openerOverride): Promise<SocketLike> {
  if (opener !== undefined) return opener(url, headers)
  const tlsOptions = getWebSocketTLSOptions()
  if (typeof Bun !== 'undefined') {
    const proxyUrl = getWebSocketProxyUrl(url)
    return new WebSocket(url, {
      headers,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as never) as unknown as SocketLike
  }
  const proxyAgent = getWebSocketProxyAgent(url)
  const { default: NodeWebSocket } = await import('ws')
  return new NodeWebSocket(url, { headers, ...(tlsOptions ?? {}), ...(proxyAgent ? { agent: proxyAgent } : {}) } as never) as unknown as SocketLike
}

function listen(socket: SocketLike, event: string, handler: (payload: unknown) => void): void {
  if (typeof socket.on === 'function') socket.on(event, handler as never)
  else socket.addEventListener?.(event, handler as never)
}

function pushFrame(entry: HeldSocket, frame: Frame): void {
  if (entry.waiter !== null) {
    const waiter = entry.waiter
    entry.waiter = null
    waiter(frame)
    return
  }
  entry.queue.push(frame)
}

function nextFrame(entry: HeldSocket): Promise<Frame> {
  const queued = entry.queue.shift()
  if (queued !== undefined) return Promise.resolve(queued)
  if (entry.closed) return Promise.resolve({ kind: 'close' })
  return new Promise<Frame>(resolve => {
    entry.waiter = resolve
  })
}

function armIdleClose(entry: HeldSocket): void {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => dropHeld(entry), SOCKET_IDLE_CLOSE_MS)
  entry.idleTimer.unref?.()
}

async function connectHeld(key: string, url: string, headers: Record<string, string>, opener: SocketOpener | undefined, now: () => number): Promise<HeldSocket> {
  const socket = await openSocket(url, { 'user-agent': getUserAgent(), ...headers }, opener)
  const entry: HeldSocket = { key, socket, openedAtMs: now(), lastResponseId: undefined, heldInput: null, inFlight: false, closed: false, queue: [], waiter: null, idleTimer: null }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`no WebSocket handshake within ${SOCKET_CONNECT_TIMEOUT_MS} ms`))
    }, SOCKET_CONNECT_TIMEOUT_MS)
    timer.unref?.()
    listen(socket, 'open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
    listen(socket, 'error', payload => {
      const message = payload instanceof Error ? payload.message : String((payload as { message?: unknown } | null)?.message ?? 'WebSocket error')
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(message))
        return
      }
      pushFrame(entry, { kind: 'error', message })
    })
    listen(socket, 'close', payload => {
      const record = (payload as { code?: unknown; reason?: unknown } | null) ?? {}
      entry.closed = true
      if (held.get(key) === entry) held.delete(key)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`WebSocket closed during the handshake (${String(record.code ?? '')})`))
        return
      }
      pushFrame(entry, { kind: 'close', ...(typeof record.code === 'number' ? { code: record.code } : {}), ...(typeof record.reason === 'string' ? { reason: record.reason } : {}) })
    })
    listen(socket, 'message', payload => {
      const raw = (payload as { data?: unknown } | null)?.data ?? payload
      pushFrame(entry, { kind: 'message', text: typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8') })
    })
  })
  held.set(key, entry)
  return entry
}

export interface OpenaiSocketOptions {
  baseUrl: string
  headers: Record<string, string>
  request: OpenaiResponsesRequest
  owner: string
  signal?: AbortSignal
  idleTimeoutMs?: number
  onStreamActivity?: (atMs: number) => void
  firstByte?: { cold: boolean; promptTokens: number; model: string; attempt?: number; onWait?: (wait: RequestWaitV1 | null) => void }
  socketImpl?: SocketOpener
  now?: () => number
}

export type SocketRoadOutcome = { kind: 'served' } | { kind: 'fell-back'; why: string }

export function socketCreateFrame(request: OpenaiResponsesRequest, previousResponseId: string | undefined, input: readonly OpenaiInputItem[]): Record<string, unknown> {
  const { stream: _stream, ...body } = request as OpenaiResponsesRequest & { stream?: boolean }
  return {
    type: 'response.create',
    ...body,
    input,
    ...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {}),
  }
}

export async function* streamOpenaiResponsesOverSocket(options: OpenaiSocketOptions): AsyncGenerator<OpenaiStreamEvent, SocketRoadOutcome> {
  const now = options.now ?? Date.now
  const key = socketRoadKey(options.baseUrl, options.headers, options.owner)
  const ledger = ledgerOf(key)
  if (ledger.restUntilMs > now()) return { kind: 'fell-back', why: `the socket road rests after ${SOCKET_FAULTS_BEFORE_REST} faults in a row` }
  const url = responsesSocketUrl(options.baseUrl)

  let entry = held.get(key)
  if (entry !== undefined && (entry.closed || entry.inFlight || now() - entry.openedAtMs >= SOCKET_ROTATION_MS)) {
    if (!entry.inFlight) dropHeld(entry)
    entry = undefined
  }
  if (entry === undefined) {
    try {
      entry = await connectHeld(key, url, options.headers, options.socketImpl ?? openerOverride, now)
      ledger.opened += 1
    } catch (error) {
      ledger.faults += 1
      if (ledger.faults >= SOCKET_FAULTS_BEFORE_REST) ledger.restUntilMs = now() + SOCKET_REST_MS
      ledger.fellBack += 1
      return { kind: 'fell-back', why: `connect: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const socket = entry
  socket.inFlight = true
  if (socket.idleTimer !== null) clearTimeout(socket.idleTimer)
  socket.idleTimer = null

  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const watchdog = createStreamIdleWatchdog({ timeoutMs: idleMs })
  const onAbort = (): void => dropHeld(socket)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
    kind: 'first-byte',
    cold: options.firstByte?.cold === true,
    promptTokens: options.firstByte?.promptTokens ?? 0,
    model: options.firstByte?.model ?? 'the model',
    budgetMs: firstByteBudgetMs({ cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0, idleMs }),
    sinceMs: now(),
    attempt: options.firstByte?.attempt ?? 1,
  }

  const fold = new ResponsesStreamFold()
  let framesSeen = 0
  let outputStarted = false
  let chainedFromCache = false
  const fault = (f: OpenaiStreamEvent & { type: 'stream-fault' }): OpenaiStreamEvent => f

  const send = (previousResponseId: string | undefined, input: readonly OpenaiInputItem[]): void => {
    const frame = socketCreateFrame(options.request, previousResponseId, input)
    socket.socket.send(JSON.stringify(frame))
  }

  try {
    const tail = incrementalInput(socket.heldInput, options.request.input)
    if (tail !== null && socket.lastResponseId !== undefined) {
      chainedFromCache = true
      send(socket.lastResponseId, tail)
    } else {
      send(undefined, options.request.input)
    }
    options.firstByte?.onWait?.(wait)
    let firstByteFired = false
    const firstByteTimer = setTimeout(() => {
      firstByteFired = true
      dropHeld(socket)
    }, wait.budgetMs)
    firstByteTimer.unref?.()

    for (;;) {
      let frame: Frame
      try {
        frame = await watchdog.guard(nextFrame(socket))
      } catch (error) {
        const cancelled = options.signal?.aborted === true
        dropHeld(socket)
        if (!outputStarted && !cancelled && !(error instanceof StreamIdleTimeoutError)) {
          ledger.fellBack += 1
          return { kind: 'fell-back', why: 'the socket faulted before the response began' }
        }
        yield fault({
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : error instanceof StreamIdleTimeoutError
              ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true }
              : { kind: 'transport-error', code: 'read-failed', message: error instanceof Error ? error.message : String(error), retryable: true },
          settledItems: fold.settledItems(),
        })
        return { kind: 'served' }
      }
      watchdog.noteActivity()
      if (framesSeen === 0) {
        clearTimeout(firstByteTimer)
        options.firstByte?.onWait?.(null)
      }
      framesSeen += 1
      options.onStreamActivity?.(now())

      if (frame.kind === 'close' || frame.kind === 'error') {
        const cancelled = options.signal?.aborted === true
        dropHeld(socket)
        if (cancelled) {
          yield fault({ type: 'stream-fault', fault: { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }, settledItems: fold.settledItems() })
          return { kind: 'served' }
        }
        if (firstByteFired && !outputStarted) {
          yield fault({ type: 'stream-fault', fault: { kind: 'timeout', code: 'first-byte-timeout', message: firstByteTimeoutLine(wait), retryable: true } })
          return { kind: 'served' }
        }
        if (!outputStarted) {
          ledger.faults += 1
          if (ledger.faults >= SOCKET_FAULTS_BEFORE_REST) ledger.restUntilMs = now() + SOCKET_REST_MS
          ledger.fellBack += 1
          const why = frame.kind === 'close' ? `the socket closed before the response began (${frame.code ?? 'no code'}${frame.code === SOCKET_MESSAGE_TOO_LARGE_CLOSE ? ', message too large' : ''})` : `socket error before the response began: ${frame.message}`
          return { kind: 'fell-back', why }
        }
        const bare = fold.takeBareStreamError()
        yield fault({
          type: 'stream-fault',
          fault: bare ?? {
            kind: 'truncated-stream',
            code: 'no-terminal-event',
            message: frame.kind === 'close' ? `the socket closed before response.completed/failed/incomplete (${frame.code ?? 'no code'})` : `socket error mid-stream: ${frame.message}`,
            retryable: true,
          },
          settledItems: fold.settledItems(),
        })
        return { kind: 'served' }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        dropHeld(socket)
        yield fault({ type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'bad-json-chunk', message: `unparseable socket frame: ${frame.text.slice(0, 160)}`, retryable: false }, settledItems: fold.settledItems() })
        return { kind: 'served' }
      }
      const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      if (record.type === 'error' && !outputStarted) {
        const inner = record.error !== null && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {}
        if (inner.code === 'previous_response_not_found' && chainedFromCache) {
          chainedFromCache = false
          socket.heldInput = null
          socket.lastResponseId = undefined
          ledger.replayedWhole += 1
          logForDebugging('[openai-socket] the held response left the connection cache; the whole input is sent again on the same socket')
          send(undefined, options.request.input)
          continue
        }
        dropHeld(socket)
        ledger.faults += 1
        if (ledger.faults >= SOCKET_FAULTS_BEFORE_REST) ledger.restUntilMs = now() + SOCKET_REST_MS
        ledger.fellBack += 1
        return { kind: 'fell-back', why: `the socket answered an error before the response began (${String(inner.code ?? record.status ?? 'no code')})` }
      }
      if (!outputStarted && record.type !== 'error') {
        outputStarted = true
        ledger.faults = 0
        if (chainedFromCache) ledger.chained += 1
      }
      for (const event of fold.fold(parsed)) {
        yield event
        if (event.type === 'response-id') socket.lastResponseId = event.id
        if (event.type === 'finish') {
          socket.heldInput = event.reason === 'completed' || event.reason === 'tool_calls' ? [...options.request.input, ...event.orderedItems] : null
        }
      }
      if (fold.finished) break
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    watchdog.stop()
    if (!socket.closed) {
      socket.inFlight = false
      armIdleClose(socket)
    }
  }
  if (!fold.finished) {
    dropHeld(socket)
    yield fault({ type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'no-terminal-event', message: 'the socket stream ended without response.completed/failed/incomplete', retryable: true }, settledItems: fold.settledItems() })
  }
  return { kind: 'served' }
}
