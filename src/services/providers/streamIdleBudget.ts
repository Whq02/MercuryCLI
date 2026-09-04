
export const STREAM_IDLE_DEFAULT_MS = 90_000

const STREAM_IDLE_FLOOR_MS = 1_000

export function streamIdleTimeoutMs(): number {
  const raw = process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= STREAM_IDLE_FLOOR_MS ? parsed : STREAM_IDLE_DEFAULT_MS
}

export function streamIdleWarningMsOf(timeoutMs: number): number {
  return timeoutMs / 2
}

export function streamIdleTimeoutMsForRoute(route: string | null): number {
  void route
  return streamIdleTimeoutMs()
}


export const COLD_INGEST_MS_PER_1K_TOKENS = 1_200
export const FIRST_BYTE_BUDGET_CEILING_MS = 300_000

export function firstByteBudgetMs(args: { cold: boolean; promptTokens: number; idleMs?: number }): number {
  const idle = args.idleMs ?? streamIdleTimeoutMs()
  if (!args.cold) return idle
  const tokens = Number.isFinite(args.promptTokens) && args.promptTokens > 0 ? args.promptTokens : 0
  const allowance = Math.round((tokens / 1000) * COLD_INGEST_MS_PER_1K_TOKENS)
  return Math.min(FIRST_BYTE_BUDGET_CEILING_MS, Math.max(idle, idle + allowance))
}

export function estimateRequestTokens(body: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(body ?? '').length / 4))
  } catch {
    return 1
  }
}

export function coldPrefixOf(messages: ReadonlyArray<unknown>, model: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index] as { type?: unknown; subtype?: unknown; message?: { model?: unknown } | null }
    if (row.type === 'system' && row.subtype === 'compact_boundary') return true
    if (row.type === 'assistant') {
      const stamped = row.message?.model
      if (typeof stamped !== 'string' || stamped === '' || stamped === '<synthetic>') continue
      return stamped !== model
    }
  }
  return true
}

export type RequestWaitV1 =
  | {
      kind: 'first-byte'
      cold: boolean
      promptTokens: number
      model: string
      budgetMs: number
      sinceMs: number
      attempt: number
    }
  | {
      kind: 'retry'
      attempt: number
      of: number
      reason: string
      delayMs: number
      sinceMs: number
    }

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`
const kTokens = (tokens: number): string => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k-token` : `${tokens}-token`)

export function requestWaitLine(wait: RequestWaitV1): string {
  if (wait.kind === 'retry') {
    return `retrying — attempt ${wait.attempt} of ${wait.of} after ${wait.reason}${wait.delayMs > 0 ? ` · in ${seconds(wait.delayMs)}` : ''}`
  }
  const again = wait.attempt > 1 ? ` (attempt ${wait.attempt})` : ''
  return wait.cold
    ? `ingesting a ${kTokens(wait.promptTokens)} prompt on ${wait.model} — first byte expected within ${seconds(wait.budgetMs)}${again}`
    : `waiting for the first byte from ${wait.model} — within ${seconds(wait.budgetMs)}${again}`
}

export function firstByteTimeoutLine(wait: Extract<RequestWaitV1, { kind: 'first-byte' }>): string {
  return `no first byte from ${wait.model} after ${seconds(wait.budgetMs)} (${
    wait.cold ? `a ${kTokens(wait.promptTokens)} prompt ingesting uncached` : 'the request was accepted and nothing arrived'
  })`
}

export function decodeRequestWait(raw: unknown): RequestWaitV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (w.kind === 'first-byte') {
    const promptTokens = num(w.promptTokens)
    const budgetMs = num(w.budgetMs)
    const sinceMs = num(w.sinceMs)
    if (typeof w.model !== 'string' || promptTokens === null || budgetMs === null || sinceMs === null) return null
    return {
      kind: 'first-byte',
      cold: w.cold === true,
      promptTokens,
      model: w.model.slice(0, 120),
      budgetMs,
      sinceMs,
      attempt: num(w.attempt) ?? 1,
    }
  }
  if (w.kind === 'retry') {
    const attempt = num(w.attempt)
    const of = num(w.of)
    const sinceMs = num(w.sinceMs)
    if (attempt === null || of === null || sinceMs === null || typeof w.reason !== 'string') return null
    return { kind: 'retry', attempt, of, reason: w.reason.slice(0, 120), delayMs: num(w.delayMs) ?? 0, sinceMs }
  }
  return null
}

export function retryReasonWords(status: number | null | undefined, message?: string): string {
  if (typeof status === 'number' && status > 0) return `a ${status}`
  if (message !== undefined && /no first byte/.test(message)) return 'a first-byte timeout'
  return 'a connection error'
}


export type StreamIdleFire = {
  silentMs: number
  activity: number
}

export class StreamIdleTimeoutError extends Error {
  readonly silentMs: number
  constructor(silentMs: number) {
    super(`no stream activity for ${silentMs} ms`)
    this.name = 'StreamIdleTimeoutError'
    this.silentMs = silentMs
  }
}

export interface StreamIdleWatchdog {
  noteActivity(): void
  stop(): void
  fired(): StreamIdleFire | null
  silentMs(): number
  guard<T>(pending: Promise<T>): Promise<T>
}

export function createStreamIdleWatchdog(opts: {
  timeoutMs: number
  onWarning?: (silentMs: number) => void
  onFire?: (fire: StreamIdleFire) => void
}): StreamIdleWatchdog {
  const timeoutMs = opts.timeoutMs
  const warningMs = streamIdleWarningMsOf(timeoutMs)
  let lastActivityAtMs = Date.now()
  let activity = 0
  let warnedForMs = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  let fire: StreamIdleFire | null = null
  let stopped = false
  const waiters = new Set<(error: StreamIdleTimeoutError) => void>()
  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  function onStreamIdleDeadline(): void {
    timer = null
    if (stopped || fire !== null) return
    const silentMs = Date.now() - lastActivityAtMs
    if (silentMs >= timeoutMs) {
      fire = { silentMs, activity }
      const error = new StreamIdleTimeoutError(silentMs)
      for (const reject of waiters) reject(error)
      waiters.clear()
      opts.onFire?.(fire)
      return
    }
    if (silentMs >= warningMs && warnedForMs !== lastActivityAtMs) {
      warnedForMs = lastActivityAtMs
      opts.onWarning?.(silentMs)
    }
    arm()
  }
  function arm(): void {
    const nextDeadlineAt = lastActivityAtMs + (warnedForMs === lastActivityAtMs ? timeoutMs : warningMs)
    timer = setTimeout(onStreamIdleDeadline, Math.max(0, nextDeadlineAt - Date.now()))
  }
  arm()
  return {
    noteActivity() {
      lastActivityAtMs = Date.now()
      activity++
    },
    stop() {
      stopped = true
      clear()
    },
    fired() {
      return fire
    },
    silentMs() {
      return Date.now() - lastActivityAtMs
    },
    guard<T>(pending: Promise<T>): Promise<T> {
      if (fire !== null) return Promise.reject(new StreamIdleTimeoutError(fire.silentMs))
      return new Promise<T>((resolve, reject) => {
        waiters.add(reject)
        pending.then(
          value => {
            waiters.delete(reject)
            resolve(value)
          },
          error => {
            waiters.delete(reject)
            reject(error)
          },
        )
      })
    },
  }
}


export type StreamEndV1 =
  | { reason: 'silent-after-last-item'; provider: string; silentMs: number }
  | { reason: 'closed-after-last-item'; provider: string }

export function streamEndReceiptLine(end: StreamEndV1): string {
  return end.reason === 'silent-after-last-item'
    ? `the ${end.provider} stream went silent ${seconds(end.silentMs)} after its last item; the reply stands`
    : `the ${end.provider} stream closed without its end event after its last item; the reply stands`
}

export function typedStreamEndOf(args: {
  fault: { kind: string; code: string }
  provider: string
  tailStands: boolean
  silentMs: number
}): StreamEndV1 | null {
  if (!args.tailStands) return null
  if (args.fault.kind === 'timeout' && args.fault.code === 'idle-timeout') {
    return { reason: 'silent-after-last-item', provider: args.provider, silentMs: args.silentMs }
  }
  if (args.fault.kind === 'truncated-stream' && (args.fault.code === 'no-terminal-event' || args.fault.code === 'no-finish')) {
    return { reason: 'closed-after-last-item', provider: args.provider }
  }
  return null
}
