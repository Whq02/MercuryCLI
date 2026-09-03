import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ClientOptions } from '@anthropic-ai/sdk'

import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'


type CachedApiRequest = Record<string, unknown>

type DumpState = {
  initialized: boolean
  messagesSeen: number
  lastInitHash: string | null
  lastInitFingerprint: string | null
}

const MAX_CACHED_REQUESTS = 5

const requestCache: CachedApiRequest[] = []
const dumpStates = new Map<string, DumpState>()

export function getLastApiRequests(): CachedApiRequest[] {
  return [...requestCache]
}

export function clearApiRequestCache(): void {
  requestCache.length = 0
}

export function clearDumpState(id: string): void {
  dumpStates.delete(id)
}

export function clearAllDumpState(): void {
  dumpStates.clear()
}

export function addApiRequestToCache(data: CachedApiRequest): void {
  return
  // eslint-disable-next-line no-unreachable
  requestCache.push(data)
  if (requestCache.length > MAX_CACHED_REQUESTS) requestCache.shift()
}

export function getDumpPromptsPath(id?: string): string {
  return join(getMercuryHome(), 'dump-prompts', `${id ?? getSessionId()}.jsonl`)
}

function ensureDumpState(id: string): DumpState {
  let state = dumpStates.get(id)
  if (state === undefined) {
    state = { initialized: false, messagesSeen: 0, lastInitHash: null, lastInitFingerprint: null }
    dumpStates.set(id, state)
  }
  return state
}

function appendDumpRecord(id: string, record: Record<string, unknown>): void {
  try {
    const path = getDumpPromptsPath(id)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${jsonStringify(record) ?? '{}'}\n`)
  } catch {
  }
}

function dumpRequestBody(id: string, body: string, timestamp: number): void {
  try {
    const parsed = jsonParse(body) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return
    addApiRequestToCache({ ...parsed, _capturedAt: timestamp })
    return
    // eslint-disable-next-line no-unreachable
    appendDumpRecord(id, { type: 'init', timestamp })
  } catch {
  }
}

export function createDumpPromptsFetch(id: string): ClientOptions['fetch'] {
  return async (input, init) => {
    ensureDumpState(id)
    const method = init?.method?.toUpperCase()
    const body = init?.body
    if (method === 'POST' && typeof body === 'string') {
      const timestamp = Date.now()
      setImmediate(() => dumpRequestBody(id, body, timestamp))
    }
    return fetch(input as never, init as never)
  }
}


export interface WireDumpResponse {
  status: number
  ms: number
  usage?: Record<string, number>
  input_transformations?: unknown[]
  model?: string
  stop_reason?: string | null
  text?: string
  error?: string
}

export interface WireDumpRow {
  kind: 'request'
  seq: number
  at: number
  url: string
  model: string
  source?: string
  body: unknown
  response: WireDumpResponse
}

export function wireDumpDir(): string | null {
  const raw = flagEnv('MERCURY_WIRE_DUMP')
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

export function wireDumpPath(dir: string, sessionId: string = getSessionId()): string {
  return join(dir, `${sessionId}.jsonl`)
}

export function scrubCredentials(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer ***')
}

const REPLY_TEXT_KEEP = 200

type WireEvent = {
  type?: string
  message?: { usage?: Record<string, number>; input_transformations?: unknown[]; model?: string }
  usage?: Record<string, number>
  delta?: { type?: string; text?: string; stop_reason?: string | null }
  error?: { message?: string }
  model?: string
  stop_reason?: string | null
}

export function createWireResponseReader(contentType: string): {
  feed(chunk: string): void
  end(): Partial<WireDumpResponse>
} {
  const summary: Partial<WireDumpResponse> = {}
  const sse = contentType.includes('text/event-stream')
  let text = ''
  let buffer = ''
  const takeEvent = (data: string): void => {
    let event: WireEvent
    try {
      event = JSON.parse(data) as WireEvent
    } catch {
      return
    }
    if (event.type === 'message_start' && event.message) {
      if (event.message.usage) summary.usage = { ...(summary.usage ?? {}), ...event.message.usage }
      if (Array.isArray(event.message.input_transformations)) summary.input_transformations = event.message.input_transformations
      if (typeof event.message.model === 'string') summary.model = event.message.model
    } else if (event.type === 'message_delta') {
      if (event.usage) summary.usage = { ...(summary.usage ?? {}), ...event.usage }
      if (event.delta && 'stop_reason' in event.delta) summary.stop_reason = event.delta.stop_reason ?? null
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      if (text.length < REPLY_TEXT_KEEP) text += event.delta.text
    } else if (event.type === 'error' && event.error) {
      summary.error = String(event.error.message ?? 'error')
    }
  }
  return {
    feed(chunk: string): void {
      buffer += chunk
      if (!sse) return
      let at: number
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (line.startsWith('data: ')) takeEvent(line.slice(6))
      }
    },
    end(): Partial<WireDumpResponse> {
      if (!sse) {
        try {
          const parsed = JSON.parse(buffer) as WireEvent
          if (parsed.type === 'error') summary.error = String(parsed.error?.message ?? 'error')
          if (parsed.usage) summary.usage = parsed.usage
          if (typeof parsed.model === 'string') summary.model = parsed.model
          if ('stop_reason' in parsed) summary.stop_reason = parsed.stop_reason ?? null
        } catch {
        }
      }
      if (text.length > 0) summary.text = text.slice(0, REPLY_TEXT_KEEP)
      return summary
    },
  }
}

let wireSeq = 0

function appendWireRow(dir: string, row: WireDumpRow): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(wireDumpPath(dir), `${JSON.stringify(row)}\n`)
  } catch {
  }
}

async function drainWireCopy(
  stream: ReadableStream<Uint8Array>,
  reader: ReturnType<typeof createWireResponseReader>,
): Promise<Partial<WireDumpResponse>> {
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      reader.feed(decoder.decode(chunk, { stream: true }))
    }
  } catch (error) {
    const summary = reader.end()
    return { ...summary, error: summary.error ?? `the body ended early: ${String(error)}` }
  }
  return reader.end()
}

export function wrapFetchWithWireDump(baseFetch: typeof globalThis.fetch, source?: string): typeof globalThis.fetch {
  const dir = wireDumpDir()
  if (dir === null) return baseFetch
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let path = url
    try {
      path = new URL(url).pathname
    } catch {
    }
    const rawBody = typeof init?.body === 'string' ? init.body : null
    if (method !== 'POST' || rawBody === null || !path.includes('/messages') || path.includes('count_tokens')) {
      return baseFetch(input, init)
    }
    const at = Date.now()
    const seq = ++wireSeq
    const write = (response: WireDumpResponse): void => {
      let body: unknown
      try {
        body = JSON.parse(scrubCredentials(rawBody))
      } catch {
        body = { unparseable: true }
      }
      const model = typeof (body as { model?: unknown } | null)?.model === 'string' ? (body as { model: string }).model : ''
      appendWireRow(dir, { kind: 'request', seq, at, url: path, model, ...(source !== undefined ? { source } : {}), body, response })
    }
    let response: Response
    try {
      response = await baseFetch(input, init)
    } catch (error) {
      write({ status: 0, ms: Date.now() - at, error: String(error) })
      throw error
    }
    if (response.body === null) {
      write({ status: response.status, ms: Date.now() - at })
      return response
    }
    const [forCaller, forDump] = response.body.tee()
    const reader = createWireResponseReader(response.headers.get('content-type') ?? '')
    void drainWireCopy(forDump, reader).then(summary => write({ status: response.status, ms: Date.now() - at, ...summary }))
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
