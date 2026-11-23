import { passedOver } from '../errors/passedOver.js'
import { abortedError, sleep } from './sleep.js'
import { startTimeout, stopTimeout } from './timers.js'

export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError'
  readonly code = 'DEADLINE_EXCEEDED'
  constructor(
    readonly seam: string,
    readonly limitMs: number,
    readonly elapsedMs: number,
    readonly progressCount: number,
    readonly advice?: string,
  ) {
    super(
      `${seam}: no progress for ${formatLimit(limitMs)} (${progressCount} progress event${progressCount === 1 ? '' : 's'} before the silence, ${formatLimit(elapsedMs)} total)${advice ? ` — ${advice}` : ''}`,
    )
  }
}

export function isDeadlineExceeded(err: unknown): err is DeadlineExceededError {
  return err instanceof DeadlineExceededError || (err as { code?: unknown } | null)?.code === 'DEADLINE_EXCEEDED'
}

export function formatLimit(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unbounded'
  const wholeMs = Math.round(ms)
  if (wholeMs < 1000) return `${wholeMs}ms`
  const wholeSeconds = Math.round(ms / 1000)
  if (wholeSeconds < 60) return `${wholeSeconds}s`
  if (wholeSeconds < 3600) {
    const minutes = Math.floor(wholeSeconds / 60)
    const seconds = wholeSeconds % 60
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
  }
  const wholeMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(wholeMinutes / 60)
  const minutes = wholeMinutes % 60
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
}

export interface InactivityDeadline {
  touch(): void
  cancel(): void
  readonly expiry: Promise<never>
  within<T>(work: PromiseLike<T>): Promise<T>
  readonly signal: AbortSignal
  readonly fired: boolean
  readonly progressCount: number
  readonly armed: boolean
}

interface InactivityDeadlineOptions {
  seam: string
  limitMs: number
  advice?: string
  onExpire?: (error: DeadlineExceededError) => void
  now?: () => number
}

export function armInactivityDeadline(opts: InactivityDeadlineOptions): InactivityDeadline {
  const now = opts.now ?? Date.now
  const limitMs = opts.limitMs
  const armed = Number.isFinite(limitMs) && limitMs > 0
  const controller = new AbortController()
  let rejectExpiry: (err: DeadlineExceededError) => void = () => {}
  const expiry = new Promise<never>((_, reject) => {
    rejectExpiry = reject
  })
  expiry.catch(passedOver)
  const within = <T>(work: PromiseLike<T>): Promise<T> => Promise.race([work, expiry])

  if (!armed) {
    return {
      touch: () => {},
      cancel: () => {},
      expiry,
      within,
      signal: controller.signal,
      fired: false,
      progressCount: 0,
      armed: false,
    }
  }

  const armedAt = now()
  let lastProgressAt = armedAt
  let progressCount = 0
  let fired = false
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const expire = (): void => {
    fired = true
    timer = null
    const error = new DeadlineExceededError(opts.seam, limitMs, now() - armedAt, progressCount, opts.advice)
    try {
      opts.onExpire?.(error)
    } finally {
      controller.abort(error)
      rejectExpiry(error)
    }
  }

  const schedule = (delayMs: number): void => {
    timer = startTimeout(check, Math.max(1, delayMs))
    timer.unref?.()
  }

  const check = (): void => {
    timer = null
    if (cancelled || fired) return
    const silence = now() - lastProgressAt
    if (silence >= limitMs) expire()
    else schedule(limitMs - silence)
  }

  schedule(limitMs)

  return {
    touch(): void {
      if (cancelled || fired) return
      lastProgressAt = now()
      progressCount++
    },
    cancel(): void {
      cancelled = true
      if (timer !== null) {
        stopTimeout(timer)
        timer = null
      }
    },
    expiry,
    within,
    signal: controller.signal,
    get fired() {
      return fired
    },
    get progressCount() {
      return progressCount
    },
    armed: true,
  }
}

export async function withInactivityDeadline<T>(
  opts: InactivityDeadlineOptions & { signal?: AbortController },
  work: (deadline: InactivityDeadline) => Promise<T>,
): Promise<T> {
  const deadline = armInactivityDeadline({
    ...opts,
    onExpire: error => {
      opts.onExpire?.(error)
      opts.signal?.abort(error)
    },
  })
  try {
    return await deadline.within(work(deadline))
  } finally {
    deadline.cancel()
  }
}

type WaitEnds<A> = { signal?: AbortSignal; onAbort?: () => A; unref?: boolean }

export function withDeadline<T, F = never, A = never>(work: PromiseLike<T>, limitMs: number, atLimit: () => F, opts: WaitEnds<A> = {}): Promise<T | NoInfer<F> | NoInfer<A>> {
  const { signal } = opts
  return new Promise<T | F | A>((resolve, reject) => {
    let open = true
    const end = (outcome: () => T | F | A): void => {
      if (!open) return
      open = false
      stopTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      try {
        resolve(outcome())
      } catch (error) {
        reject(error)
      }
    }
    const aborted = (): void => end(opts.onAbort ?? (() => { throw abortedError(signal) }))
    const timer = Number.isFinite(limitMs) ? startTimeout(() => end(atLimit), limitMs) : undefined
    if (opts.unref) timer?.unref?.()
    work.then(
      value => end(() => value),
      error => end(() => { throw error }),
    )
    if (signal?.aborted) aborted()
    else signal?.addEventListener('abort', aborted, { once: true })
  })
}

export async function pollUntil<T, F = never, A = never>(look: () => T | undefined | PromiseLike<T | undefined>, everyMs: number | ((leftMs: number) => number), limitMs: number, atLimit: () => F, opts: WaitEnds<A> = {}): Promise<T | NoInfer<F> | NoInfer<A>> {
  const { signal } = opts
  const until = Date.now() + limitMs
  for (;;) {
    if (signal?.aborted) {
      if (opts.onAbort) return opts.onAbort()
      throw abortedError(signal)
    }
    const seen = await look()
    if (seen !== undefined) return seen
    const left = until - Date.now()
    if (left <= 0) return atLimit()
    await sleep(typeof everyMs === 'number' ? everyMs : everyMs(left), signal, { unref: opts.unref })
  }
}

export function declaredWaitEnd(sinceMs: number, declaredMs: number, capMs: number): number {
  return sinceMs + Math.max(0, Math.min(declaredMs, capMs))
}

export function holdDeadlineUntil(deadline: Pick<InactivityDeadline, 'touch'>, untilMs: number, stepMs: number, now: () => number = Date.now): { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const step = (): void => {
    deadline.touch()
    const left = untilMs - now()
    if (left <= 0) {
      timer = null
      return
    }
    timer = startTimeout(step, Math.max(1, Math.min(left, stepMs)))
    timer.unref?.()
  }
  step()
  return {
    cancel(): void {
      if (timer !== null) stopTimeout(timer)
      timer = null
    },
  }
}

export function minutesKnobToMs(raw: string | undefined, defaultMinutes: number): number {
  if (raw === undefined || raw.trim() === '') return defaultMinutes * 60_000
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMinutes * 60_000
  return parsed * 60_000
}

const TIME_SPAN_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }

export function timeSpanMsOf(raw: string): number | null {
  const text = raw.replace(/\s+/g, '').toLowerCase()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text)
    return seconds > 0 ? seconds * 1_000 : null
  }
  if (!/^(\d+(?:\.\d+)?[smh])+$/.test(text)) return null
  let total = 0
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)([smh])/g)) total += Number(part[1]) * TIME_SPAN_UNIT_MS[part[2]!]!
  return total > 0 ? total : null
}
