
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
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
}

export interface InactivityDeadline {
  touch(): void
  cancel(): void
  readonly expiry: Promise<never>
  readonly signal: AbortSignal
  readonly fired: boolean
  readonly progressCount: number
  readonly armed: boolean
}

export interface InactivityDeadlineOptions {
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
  expiry.catch(() => {})

  if (!armed) {
    return {
      touch: () => {},
      cancel: () => {},
      expiry,
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
    timer = setTimeout(check, Math.max(1, delayMs))
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
        clearTimeout(timer)
        timer = null
      }
    },
    expiry,
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
    return await Promise.race([work(deadline), deadline.expiry])
  } finally {
    deadline.cancel()
  }
}

export function minutesKnobToMs(raw: string | undefined, defaultMinutes: number): number {
  if (raw === undefined || raw.trim() === '') return defaultMinutes * 60_000
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMinutes * 60_000
  return parsed * 60_000
}
