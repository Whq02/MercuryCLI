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
  firstByteMs?: number
  contentType?: string
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

export interface WireCatalogueModel {
  id: string
  display_name?: string
  context_window?: number
  max_context_window?: number
  efforts?: string[]
  default_effort?: string
  input_modalities?: string[]
  priority?: number
  visibility?: string
  supported_in_api?: boolean
}

export interface WireCatalogueRow {
  kind: 'catalogue'
  seq: number
  at: number
  url: string
  source?: string
  response: { status: number; ms: number; firstByteMs?: number; models?: WireCatalogueModel[]; error?: string }
}

export function readCatalogueModels(body: unknown): WireCatalogueModel[] {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value
          .map(v => (typeof v === 'string' ? v : typeof (v as { effort?: unknown } | null)?.effort === 'string' ? (v as { effort: string }).effort : ''))
          .filter(v => v !== '')
      : undefined
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const out: WireCatalogueModel[] = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : typeof r.slug === 'string' ? r.slug : ''
    if (id === '') continue
    const efforts = strings(r.supported_reasoning_levels)
    const modalities = strings(r.input_modalities)
    const window = count(r.context_window)
    const ceiling = count(r.max_context_window)
    const priority = count(r.priority)
    out.push({
      id,
      ...(typeof r.display_name === 'string' ? { display_name: r.display_name } : {}),
      ...(window !== undefined ? { context_window: window } : {}),
      ...(ceiling !== undefined ? { max_context_window: ceiling } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(typeof r.default_reasoning_level === 'string' ? { default_effort: r.default_reasoning_level } : {}),
      ...(modalities !== undefined ? { input_modalities: modalities } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(typeof r.visibility === 'string' ? { visibility: r.visibility } : {}),
      ...(typeof r.supported_in_api === 'boolean' ? { supported_in_api: r.supported_in_api } : {}),
    })
  }
  return out
}

export function flattenResponsesUsage(usage: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') out[key] = value
    else if (value !== null && typeof value === 'object') {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nested === 'number') out[inner] = nested
      }
    }
  }
  return out
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
  message?: { usage?: Record<string, number>; input_transformations?: unknown[]; model?: string } | string
  usage?: Record<string, number>
  delta?: { type?: string; text?: string; stop_reason?: string | null } | string
  error?: { message?: string }
  model?: string
  stop_reason?: string | null
  response?: { usage?: Record<string, unknown>; model?: string; error?: { message?: string }; incomplete_details?: { reason?: string } }
  object?: string
}

export function createWireResponseReader(contentType: string): {
  feed(chunk: string): void
  end(): Partial<WireDumpResponse>
} {
  const summary: Partial<WireDumpResponse> = {}
  let sse: boolean | null = contentType.includes('text/event-stream') ? true : null
  let text = ''
  let buffer = ''
  const takeResponse = (type: string, response: NonNullable<WireEvent['response']>): void => {
    if (response.usage && typeof response.usage === 'object') summary.usage = flattenResponsesUsage(response.usage)
    if (typeof response.model === 'string') summary.model = response.model
    if (type === 'response.completed') summary.stop_reason = 'completed'
    else if (type === 'response.incomplete') summary.stop_reason = `incomplete${response.incomplete_details?.reason ? `:${response.incomplete_details.reason}` : ''}`
    else summary.error = String(response.error?.message ?? 'failed')
  }
  const takeEvent = (data: string): void => {
    let event: WireEvent
    try {
      event = JSON.parse(data) as WireEvent
    } catch {
      return
    }
    if (event.type === 'message_start' && event.message && typeof event.message === 'object') {
      if (event.message.usage) summary.usage = { ...(summary.usage ?? {}), ...event.message.usage }
      if (Array.isArray(event.message.input_transformations)) summary.input_transformations = event.message.input_transformations
      if (typeof event.message.model === 'string') summary.model = event.message.model
    } else if (event.type === 'message_delta') {
      if (event.usage) summary.usage = { ...(summary.usage ?? {}), ...event.usage }
      if (event.delta && typeof event.delta === 'object' && 'stop_reason' in event.delta) summary.stop_reason = event.delta.stop_reason ?? null
    } else if (event.type === 'content_block_delta' && typeof event.delta === 'object' && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
      if (text.length < REPLY_TEXT_KEEP) text += event.delta.text
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (text.length < REPLY_TEXT_KEEP) text += event.delta
    } else if ((event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') && event.response) {
      takeResponse(event.type, event.response)
    } else if (event.type === 'error') {
      summary.error = String(event.error?.message ?? (typeof event.message === 'string' ? event.message : 'error'))
    }
  }
  return {
    feed(chunk: string): void {
      buffer += chunk
      if (sse === null) {
        const head = buffer.replace(/^\s+/, '')
        if (head === '') return
        sse = /^(event:|data:|:)/.test(head)
      }
      if (!sse) return
      let at: number
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (line.startsWith('data: ')) takeEvent(line.slice(6))
      }
    },
    end(): Partial<WireDumpResponse> {
      if (sse !== true) {
        try {
          const parsed = JSON.parse(buffer) as WireEvent
          if (parsed.type === 'error' || (parsed.error !== undefined && typeof parsed.error === 'object')) summary.error = String(parsed.error?.message ?? 'error')
          if (parsed.usage) summary.usage = parsed.object === 'response' ? flattenResponsesUsage(parsed.usage) : parsed.usage
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

export interface WireFoldRow {
  kind: 'fold'
  seq: number
  at: number
  family: string
  road: 'fork' | 'direct'
  model: string
  outcome: 'summary' | 'overflow' | 'handover' | 'refused' | 'timeout' | 'aborted' | 'incomplete'
  ms: number
  detail?: string
}

let wireSeq = 0

function appendWireRow(dir: string, row: WireDumpRow | WireCatalogueRow | WireFoldRow): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(wireDumpPath(dir), `${JSON.stringify(row)}\n`)
  } catch {
  }
}

export function recordWireFoldRow(row: Omit<WireFoldRow, 'kind' | 'seq' | 'at'>): void {
  const dir = wireDumpDir()
  if (dir === null) return
  appendWireRow(dir, { kind: 'fold', seq: ++wireSeq, at: Date.now(), ...row })
}

function tapBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  onEnd: (fault: string | null) => void,
): ReadableStream<Uint8Array> {
  const source = body.getReader()
  const decoder = new TextDecoder()
  let ended = false
  const end = (fault: string | null): void => {
    if (ended) return
    ended = true
    try {
      onEnd(fault)
    } catch {
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await source.read()
      } catch (error) {
        end(String(error))
        controller.error(error)
        return
      }
      if (next.done) {
        end(null)
        controller.close()
        return
      }
      try {
        onChunk(decoder.decode(next.value, { stream: true }))
      } catch {
      }
      controller.enqueue(next.value)
    },
    cancel(reason) {
      end(reason === undefined ? 'cancelled by the caller' : String(reason))
      return source.cancel(reason)
    },
  })
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
    const requestRoad =
      method === 'POST' && rawBody !== null && (path.includes('/messages') || path.endsWith('/responses')) && !path.includes('count_tokens')
    const catalogueRoad = method === 'GET' && path.endsWith('/models')
    if (!requestRoad && !catalogueRoad) return baseFetch(input, init)
    const at = Date.now()
    const seq = ++wireSeq
    if (catalogueRoad) {
      const writeCatalogue = (response: WireCatalogueRow['response']): void => {
        appendWireRow(dir, { kind: 'catalogue', seq, at, url: path, ...(source !== undefined ? { source } : {}), response })
      }
      let listed: Response
      try {
        listed = await baseFetch(input, init)
      } catch (error) {
        writeCatalogue({ status: 0, ms: Date.now() - at, error: String(error) })
        throw error
      }
      const firstByteMs = Date.now() - at
      if (listed.body === null) {
        writeCatalogue({ status: listed.status, ms: firstByteMs, firstByteMs })
        return listed
      }
      let text = ''
      const tapped = tapBody(
        listed.body,
        chunk => {
          text += chunk
        },
        fault => {
          let models: WireCatalogueModel[] | undefined
          let error: string | undefined
          try {
            models = readCatalogueModels(JSON.parse(text))
          } catch {
            error = fault !== null ? `the body ended early: ${fault}` : 'the body was not JSON'
          }
          writeCatalogue({
            status: listed.status,
            ms: Date.now() - at,
            firstByteMs,
            ...(models !== undefined ? { models } : {}),
            ...(error !== undefined ? { error } : {}),
          })
        },
      )
      return new Response(tapped, { status: listed.status, statusText: listed.statusText, headers: listed.headers })
    }
    const write = (response: WireDumpResponse): void => {
      let body: unknown
      try {
        body = JSON.parse(scrubCredentials(rawBody as string))
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
    const firstByteMs = Date.now() - at
    if (response.body === null) {
      write({ status: response.status, ms: firstByteMs, firstByteMs })
      return response
    }
    const contentType = response.headers.get('content-type') ?? ''
    const reader = createWireResponseReader(contentType)
    const tapped = tapBody(
      response.body,
      chunk => reader.feed(chunk),
      fault => {
        const summary = reader.end()
        const terminal = summary.stop_reason !== undefined || summary.usage !== undefined || summary.error !== undefined
        write({
          status: response.status,
          ms: Date.now() - at,
          firstByteMs,
          ...(contentType !== '' ? { contentType } : {}),
          ...summary,
          ...(fault !== null && !terminal ? { error: `the body ended early: ${fault}` } : {}),
        })
      },
    )
    return new Response(tapped, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
