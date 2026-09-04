
export type AgentWaitPhase =
  | 'request-sent'
  | 'first-byte'
  | 'retry'
  | 'replying'
  | 'reasoning'
  | 'streaming'
  | 'tool'

export type AgentWaitV1 = {
  phase: AgentWaitPhase
  sinceMs: number
  budgetMs?: number
  reason?: string
  attempt?: number
  of?: number
}

type StreamEventLike = {
  type?: string
  subtype?: string
  event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string } }
  wait?: unknown
  retryInMs?: number
  retryAttempt?: number
  message?: { content?: unknown }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function decodeWait(raw: unknown): { kind: 'first-byte'; budgetMs: number; sinceMs?: number } | { kind: 'retry'; delayMs: number; reason?: string; attempt?: number; of?: number; sinceMs?: number } | null {
  if (!isRecord(raw)) return null
  const sinceMs = typeof raw.sinceMs === 'number' && Number.isFinite(raw.sinceMs) ? raw.sinceMs : undefined
  if (raw.kind === 'first-byte' && typeof raw.budgetMs === 'number' && raw.budgetMs > 0) {
    return { kind: 'first-byte', budgetMs: raw.budgetMs, ...(sinceMs !== undefined ? { sinceMs } : {}) }
  }
  if (raw.kind === 'retry' && typeof raw.delayMs === 'number') {
    return {
      kind: 'retry',
      delayMs: raw.delayMs,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(typeof raw.attempt === 'number' ? { attempt: raw.attempt } : {}),
      ...(typeof raw.of === 'number' ? { of: raw.of } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
    }
  }
  return null
}

export function foldAgentWaitEvent(prev: AgentWaitV1 | null, raw: unknown, nowMs: number): AgentWaitV1 | null {
  if (!isRecord(raw)) return prev
  const event = raw as StreamEventLike
  const next = (phase: AgentWaitPhase, extra: Partial<AgentWaitV1> = {}): AgentWaitV1 =>
    prev !== null && prev.phase === phase && extra.budgetMs === prev.budgetMs && extra.reason === prev.reason ? prev : { phase, sinceMs: nowMs, ...extra }
  switch (event.type) {
    case 'stream_request_start':
      return next('request-sent')
    case 'request_wait': {
      const wait = decodeWait(event.wait)
      if (wait === null) {
        return prev !== null && (prev.phase === 'first-byte' || prev.phase === 'retry') ? { phase: 'replying', sinceMs: nowMs } : prev
      }
      if (wait.kind === 'first-byte') {
        return prev !== null && prev.phase === 'first-byte' && prev.budgetMs === wait.budgetMs ? prev : { phase: 'first-byte', sinceMs: wait.sinceMs ?? nowMs, budgetMs: wait.budgetMs }
      }
      return {
        phase: 'retry',
        sinceMs: wait.sinceMs ?? nowMs,
        budgetMs: wait.delayMs,
        ...(wait.reason !== undefined ? { reason: wait.reason } : {}),
        ...(wait.attempt !== undefined ? { attempt: wait.attempt } : {}),
        ...(wait.of !== undefined ? { of: wait.of } : {}),
      }
    }
    case 'stream_event': {
      const ev = event.event
      if (!ev) return prev
      if (ev.type === 'message_start') {
        return prev !== null && (prev.phase === 'reasoning' || prev.phase === 'streaming') ? prev : next('replying')
      }
      const blockType = ev.type === 'content_block_start' ? ev.content_block?.type : undefined
      const deltaType = ev.type === 'content_block_delta' ? ev.delta?.type : undefined
      if (blockType === 'thinking' || blockType === 'redacted_thinking' || deltaType === 'thinking_delta') {
        return prev !== null && prev.phase === 'reasoning' ? prev : { phase: 'reasoning', sinceMs: nowMs }
      }
      if (blockType === 'text' || blockType === 'tool_use' || deltaType === 'text_delta' || deltaType === 'input_json_delta') {
        return prev !== null && prev.phase === 'streaming' ? prev : { phase: 'streaming', sinceMs: nowMs }
      }
      return prev
    }
    case 'system': {
      if (event.subtype !== 'api_error') return prev
      const delay = typeof event.retryInMs === 'number' && event.retryInMs > 0 ? event.retryInMs : undefined
      if (delay === undefined) return prev
      return {
        phase: 'retry',
        sinceMs: nowMs,
        budgetMs: delay,
        reason: 'a provider fault',
        ...(typeof event.retryAttempt === 'number' ? { attempt: event.retryAttempt } : {}),
      }
    }
    case 'assistant': {
      const content = event.message?.content
      const callsTools = Array.isArray(content) && content.some(block => isRecord(block) && block.type === 'tool_use')
      return callsTools ? next('tool') : prev
    }
    default:
      return prev
  }
}

export function agentWaitElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function agentWaitWords(wait: AgentWaitV1 | null | undefined, nowMs: number): string | null {
  if (!wait) return null
  const elapsed = agentWaitElapsed(nowMs - wait.sinceMs)
  switch (wait.phase) {
    case 'request-sent':
      return 'request sent'
    case 'first-byte':
      return `waiting for the first byte · ${elapsed}, within ${Math.max(1, Math.round((wait.budgetMs ?? 0) / 1000))} s`
    case 'retry': {
      const delay = Math.max(1, Math.round((wait.budgetMs ?? 0) / 1000))
      const ladder = wait.attempt !== undefined ? ` (retry ${wait.attempt}${wait.of !== undefined ? ` of ${wait.of}` : ''})` : ''
      return `retrying in ${delay} s — ${wait.reason ?? 'a provider fault'}${ladder}`
    }
    case 'replying':
      return 'first byte in, no tokens yet'
    case 'reasoning':
      return `reasoning ${elapsed}, no tokens yet`
    case 'streaming':
      return 'streaming'
    case 'tool':
      return null
  }
}
