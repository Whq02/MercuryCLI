import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { retryAfterHeaderMs } from '../api/retryAfter.js'
import { deadlineBreachLine } from '../providers/fetchDeadline.js'
import {
  JEV_BASE_URL,
  JEV_MODEL_PIN,
  JEV_PROVIDER_NAME,
  JEV_SYSTEMONE_PATH,
  JEV_TIMEOUT_MS,
  type JevAnswer,
  type JevQuestion,
  type JevRequest,
  type JevResponse,
  type JevWireOutcome,
  jevWireFailureKindForStatus,
} from './jevContract.js'

declare const MACRO: { VERSION: string }

export const JEV_REQUEST_ID_HEADER = 'x-typesafe-request-id'
export const JEV_RETRY_AFTER_MS_HEADER = 'retry-after-ms'
export const JEV_RETRY_AFTER_HEADER = 'retry-after'
export const JEV_DETAIL_CLIP = 400

export type JevRequestInput = Pick<JevRequest, 'state' | 'questions'>

export interface JevClientIo {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export type JevDecode = { ok: true; response: JevResponse } | { ok: false; path: string; reason: string }

type Decoded<T> = { ok: true; value: T } | { ok: false; path: string; reason: string }

export function jevBaseUrl(): string {
  const pinned = flagEnv('MERCURY_JEV_BASE')?.trim()
  return (pinned || JEV_BASE_URL).replace(/\/+$/, '')
}

export function jevSystemOneUrl(): string {
  return `${jevBaseUrl()}${JEV_SYSTEMONE_PATH}`
}

export function jevUserAgent(): string {
  return `mercury/${MACRO.VERSION}`
}

export function jevWireRequest(input: JevRequestInput): JevRequest {
  return { model: JEV_MODEL_PIN, state: input.state, questions: input.questions }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function decodeProbabilities(raw: unknown, expected: readonly string[], path: string): Decoded<Record<string, number>> {
  if (!isRecord(raw)) return { ok: false, path, reason: 'missing or not an object of probabilities' }
  const out: Record<string, number> = {}
  for (const [key, p] of Object.entries(raw)) {
    if (!isUnit(p)) return { ok: false, path: `${path}.${key}`, reason: 'not a probability in 0..1' }
    out[key] = p
  }
  for (const key of expected) {
    if (!(key in out)) return { ok: false, path: `${path}.${key}`, reason: 'missing' }
  }
  return { ok: true, value: out }
}

function decodeAnswer(raw: unknown, question: JevQuestion, path: string): Decoded<JevAnswer> {
  if (!isRecord(raw)) return { ok: false, path, reason: 'missing or not an object' }
  if (raw.type !== question.type) return { ok: false, path: `${path}.type`, reason: `expected "${question.type}", got ${JSON.stringify(raw.type)}` }
  if (question.type === 'noul') {
    if (!isUnit(raw.noul)) return { ok: false, path: `${path}.noul`, reason: 'missing or not a probability in 0..1' }
    return { ok: true, value: { type: 'noul', noul: raw.noul } }
  }
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string') return { ok: false, path: `${path}.choice`, reason: 'missing or not a string' }
    const probabilities = decodeProbabilities(raw.probabilities, Object.keys(question.criteria), `${path}.probabilities`)
    if (!probabilities.ok) return probabilities
    if (!(raw.choice in probabilities.value)) return { ok: false, path: `${path}.choice`, reason: `"${raw.choice}" is not one of the options` }
    if (!isUnit(raw.confidence)) return { ok: false, path: `${path}.confidence`, reason: 'missing or not a number in 0..1' }
    return { ok: true, value: { type: 'choice', choice: raw.choice, probabilities: probabilities.value, confidence: raw.confidence } }
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return { ok: false, path: `${path}.score`, reason: 'missing or not a number' }
  if (!isRecord(raw.legend)) return { ok: false, path: `${path}.legend`, reason: 'missing or not an object' }
  const legend: Record<string, string> = {}
  for (const [key, level] of Object.entries(raw.legend)) {
    if (typeof level !== 'string') return { ok: false, path: `${path}.legend.${key}`, reason: 'not a string' }
    legend[key] = level
  }
  const indices = question.criteria.map((_, index) => String(index))
  for (const index of indices) {
    if (!(index in legend)) return { ok: false, path: `${path}.legend.${index}`, reason: 'missing' }
  }
  if (Object.keys(legend).length !== indices.length) return { ok: false, path: `${path}.legend`, reason: `expected ${indices.length} levels, got ${Object.keys(legend).length}` }
  const probabilities = decodeProbabilities(raw.probabilities, indices, `${path}.probabilities`)
  if (!probabilities.ok) return probabilities
  if (!isUnit(raw.confidence)) return { ok: false, path: `${path}.confidence`, reason: 'missing or not a number in 0..1' }
  return { ok: true, value: { type: 'score', score: raw.score, legend, probabilities: probabilities.value, confidence: raw.confidence } }
}

export function decodeJevResponse(body: unknown, questions: Record<string, JevQuestion>): JevDecode {
  if (!isRecord(body)) return { ok: false, path: '$', reason: 'the body is not a JSON object' }
  if (typeof body.model !== 'string' || body.model === '') return { ok: false, path: 'model', reason: 'missing or not a string' }
  if (!isRecord(body.answers)) return { ok: false, path: 'answers', reason: 'missing or not an object' }
  const answers: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const decoded = decodeAnswer(body.answers[id], question, `answers.${id}`)
    if (!decoded.ok) return decoded
    answers[id] = decoded.value
  }
  if (!isRecord(body.usage)) return { ok: false, path: 'usage', reason: 'missing or not an object' }
  if (!isCount(body.usage.input_tokens)) return { ok: false, path: 'usage.input_tokens', reason: 'missing or not a non-negative number' }
  if (!isCount(body.usage.output_tokens)) return { ok: false, path: 'usage.output_tokens', reason: 'missing or not a non-negative number' }
  return {
    ok: true,
    response: { model: body.model, answers, usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens } },
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function wireMessage(parsed: unknown, depth = 0): string | undefined {
  if (!isRecord(parsed) || depth > 2) return undefined
  for (const key of ['message', 'detail', 'error']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (isRecord(value)) {
      const inner = wireMessage(value, depth + 1)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

export function jevFailureDetail(text: string): string {
  const message = wireMessage(parseJson(text))
  const words = (message ?? text).replace(/\s+/g, ' ').trim()
  if (words === '') return '(empty body)'
  return words.length > JEV_DETAIL_CLIP ? `${words.slice(0, JEV_DETAIL_CLIP - 3)}...` : words
}

export function jevRetryAfterMs(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const ms = headers.get(JEV_RETRY_AFTER_MS_HEADER)
  if (ms !== null && ms.trim() !== '') {
    const parsed = Number(ms.trim())
    if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed)
  }
  return retryAfterHeaderMs(headers.get(JEV_RETRY_AFTER_HEADER), nowMs)
}

export async function jevSystemOne(input: JevRequestInput, key: string, io: JevClientIo = {}): Promise<JevWireOutcome> {
  const request = jevWireRequest(input)
  const timeoutMs = io.timeoutMs ?? JEV_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = io.signal ? AbortSignal.any([io.signal, deadline]) : deadline
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const transport = io.fetchImpl ? {} : getProxyFetchOptions()
  const scrub = (text: string): string => (key.length >= 8 ? text.split(key).join('<key>') : text)
  const failed = (error: unknown): JevWireOutcome => {
    if (io.signal?.aborted) return { ok: false, failure: { kind: 'aborted', detail: 'cancelled before an answer arrived' } }
    if (deadline.aborted) return { ok: false, failure: { kind: 'provider-down', detail: deadlineBreachLine(JEV_PROVIDER_NAME, timeoutMs) } }
    return { ok: false, failure: { kind: 'provider-down', detail: scrub(`no connection — ${error instanceof Error ? error.message : String(error)}`) } }
  }
  let response: Response
  try {
    response = await fetchImpl(jevSystemOneUrl(), {
      ...transport,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': jevUserAgent(),
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(request),
      signal,
    } as RequestInit)
  } catch (error) {
    return failed(error)
  }
  const requestId = response.headers.get(JEV_REQUEST_ID_HEADER)?.trim() || undefined
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return failed(error)
  }
  if (response.status < 200 || response.status >= 300) {
    const retryAfterMs = jevRetryAfterMs(response.headers)
    return {
      ok: false,
      failure: {
        kind: jevWireFailureKindForStatus(response.status),
        status: response.status,
        detail: scrub(jevFailureDetail(text)),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      },
    }
  }
  const parsed = parseJson(text)
  if (parsed === undefined) {
    return { ok: false, failure: { kind: 'parse-failed', status: response.status, detail: 'the body is not JSON', ...(requestId !== undefined ? { requestId } : {}) } }
  }
  const decoded = decodeJevResponse(parsed, request.questions)
  if (!decoded.ok) {
    return { ok: false, failure: { kind: 'parse-failed', status: response.status, detail: `${decoded.path}: ${decoded.reason}`, ...(requestId !== undefined ? { requestId } : {}) } }
  }
  return { ok: true, response: decoded.response, ...(requestId !== undefined ? { requestId } : {}) }
}
