import { buildApiAgentOptions } from '../../../utils/proxy.js'

export type StreamCutPhase =
  | 'before-first-event'
  | 'mid-reasoning'
  | 'mid-text'
  | 'mid-tool-arguments'
  | 'between-items'

export interface StreamCutForensicsV1 {
  protocol: string
  sinceStartMs: number
  sinceHeadersMs: number
  sinceLastByteMs: number
  bytes: number
  events: number
  textDeltas: number
  reasoningDeltas: number
  toolArgumentDeltas: number
  itemsSettled: number
  phase: StreamCutPhase
  headers: Record<string, string>
  requestBytes: number
  requestSizeClass: string
  cause?: string
}

export const EDGE_HEADER_NAMES = ['cf-ray', 'cf-cache-status', 'x-request-id', 'openai-processing-ms', 'retry-after', 'content-type', 'server', 'date'] as const

const HEADER_VALUE_CAP = 80
const SENT_WORDS_CAP = 200

export function edgeHeadersOf(headers: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of EDGE_HEADER_NAMES) {
    const value = headers.get(name)
    if (value === null || value === '') continue
    out[name] = value.length > HEADER_VALUE_CAP ? `${value.slice(0, HEADER_VALUE_CAP)}…` : value
  }
  return out
}

export function requestSizeClassOf(bytes: number): string {
  if (bytes < 16 * 1024) return 'small (under 16 KB)'
  if (bytes < 128 * 1024) return 'medium (16 KB to 128 KB)'
  if (bytes < 512 * 1024) return 'large (128 KB to 512 KB)'
  return 'very large (512 KB or more)'
}

export function dispatcherProtocolWords(fetchInjected: boolean): string {
  if (fetchInjected) return 'unknown (an injected fetch)'
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'unknown (the platform fetch)'
  const options = buildApiAgentOptions() as Record<string, unknown>
  return options.allowH2 === true ? 'HTTP/2 allowed by the dispatcher' : 'HTTP/1.1 (the dispatcher allows no HTTP/2)'
}

export function streamCutPhaseOf(seen: { last: string; events: number }): StreamCutPhase {
  if (seen.events === 0) return 'before-first-event'
  switch (seen.last) {
    case 'text-delta':
    case 'refusal-delta':
      return 'mid-text'
    case 'reasoning-delta':
      return 'mid-reasoning'
    case 'tool-args-start':
    case 'tool-args-delta':
      return 'mid-tool-arguments'
    default:
      return 'between-items'
  }
}

export function causeWordsOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined || error.cause === null) return undefined
  const cause = error.cause
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? `${cause.message} (${code})` : cause.message
  }
  return String(cause)
}

export function composeStreamCutForensics(input: {
  nowMs: number
  startedAtMs: number
  headersAtMs: number
  lastByteAtMs: number
  bytes: number
  events: number
  textDeltas: number
  reasoningDeltas: number
  toolArgumentDeltas: number
  last: string
  itemsSettled: number
  headers: Record<string, string>
  requestBytes: number
  protocol: string
  cause?: string
}): StreamCutForensicsV1 {
  return {
    protocol: input.protocol,
    sinceStartMs: Math.max(0, input.nowMs - input.startedAtMs),
    sinceHeadersMs: Math.max(0, input.nowMs - input.headersAtMs),
    sinceLastByteMs: Math.max(0, input.nowMs - input.lastByteAtMs),
    bytes: input.bytes,
    events: input.events,
    textDeltas: input.textDeltas,
    reasoningDeltas: input.reasoningDeltas,
    toolArgumentDeltas: input.toolArgumentDeltas,
    itemsSettled: input.itemsSettled,
    phase: streamCutPhaseOf({ last: input.last, events: input.events }),
    headers: input.headers,
    requestBytes: input.requestBytes,
    requestSizeClass: requestSizeClassOf(input.requestBytes),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  }
}

export function streamCutForensicsWords(forensics: StreamCutForensicsV1): string {
  const headers = Object.entries(forensics.headers)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')
  return (
    `protocol=${forensics.protocol} · since-start=${forensics.sinceStartMs}ms · since-headers=${forensics.sinceHeadersMs}ms · since-last-byte=${forensics.sinceLastByteMs}ms` +
    ` · bytes=${forensics.bytes} · events=${forensics.events} · phase=${forensics.phase}` +
    ` · text-deltas=${forensics.textDeltas} · reasoning-deltas=${forensics.reasoningDeltas} · tool-argument-deltas=${forensics.toolArgumentDeltas} · items-settled=${forensics.itemsSettled}` +
    ` · request=${forensics.requestSizeClass}, ${forensics.requestBytes} bytes` +
    ` · headers: ${headers === '' ? 'none of the named ones' : headers}` +
    (forensics.cause !== undefined ? ` · cause=${forensics.cause}` : '')
  )
}

export function streamCutForensicsLine(
  road: string,
  fault: { code: string; message: string },
  forensics: StreamCutForensicsV1,
): string {
  const sent = fault.message.length > SENT_WORDS_CAP ? `${fault.message.slice(0, SENT_WORDS_CAP)}…` : fault.message
  return `[openai] stream fault forensics · road=${road} · code=${fault.code} · sent=${sent} · ${streamCutForensicsWords(forensics)}`
}

export function streamCutForensicsDetail(fault: { code: string }, forensics: StreamCutForensicsV1): string {
  return `${fault.code} · ${streamCutForensicsWords(forensics)}`
}
