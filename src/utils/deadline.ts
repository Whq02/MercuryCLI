/**
 * THE deadline primitive — one owner for the whole "waited forever" family
 * (sweep #2: headless black-holed sockets, a stalled MCP tools/call,
 * an agent that wedges before its first event, a sub-agent parked at zero
 * tool uses, a background permission ask nobody answers).
 *
 * Shape: an INACTIVITY deadline, not a wall-clock cap. Progress resets the
 * clock (`touch`), so a long operation that keeps reporting stays alive and
 * only a SILENT one expires. Expiry is typed (`DeadlineExceededError` with
 * the seam, the limit, the elapsed time, and how much progress was seen) so
 * every consumer renders the same honest sentence instead of a bare hang or
 * an anonymous timeout (law 1).
 *
 * Mechanics: one lazily re-armed unreferenced timer. `touch()` only stamps a
 * clock; the timer, when it fires, either expires or re-arms for the
 * remainder — cheap enough for stream-event hot paths. A non-positive or
 * non-finite limit means DISABLED: the deadline never fires and every call
 * is a no-op, so an operator-set 0 reads as "off" everywhere.
 */

export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError'
  readonly code = 'DEADLINE_EXCEEDED'
  constructor(
    /** Where the wait happened, in Mercury's vocabulary ("MCP tool call"). */
    readonly seam: string,
    readonly limitMs: number,
    readonly elapsedMs: number,
    /** How many progress touches arrived before the silence that expired. */
    readonly progressCount: number,
    /** What the reader can DO about it — the actionable half. */
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
  /** Progress observed — the silence clock restarts. */
  touch(): void
  /** Disarm (idempotent). Call on every settle path; a fired deadline stays fired. */
  cancel(): void
  /** Rejects with DeadlineExceededError when the deadline fires; never resolves. */
  readonly expiry: Promise<never>
  /** Aborts when the deadline fires (for signal-shaped consumers). */
  readonly signal: AbortSignal
  readonly fired: boolean
  readonly progressCount: number
  /** Whether the limit is live at all (false ⇒ disabled; every call a no-op). */
  readonly armed: boolean
}

export interface InactivityDeadlineOptions {
  seam: string
  limitMs: number
  advice?: string
  /** Fires exactly once, synchronously with expiry (before the rejection lands). */
  onExpire?: (error: DeadlineExceededError) => void
  /** Clock injection for provers. */
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
  // A consumer that never races the promise must not surface an unhandled
  // rejection; racing consumers still receive it.
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

/**
 * Run `work` under an inactivity deadline: the returned promise settles with
 * the work's own outcome, or rejects with DeadlineExceededError the moment the
 * silence limit is crossed. The work keeps running after expiry (a deadline on
 * WAITING — the caller's abort signal is the cancellation, if it wants one);
 * pass `signal` and the deadline aborts it on expiry too.
 */
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

/**
 * Minutes-valued operator knob → milliseconds. Non-numeric or negative reads
 * fall to the default; an explicit 0 disables (returns 0). The registered
 * flag's consumer passes the raw value; the registry owns the spelling.
 */
export function minutesKnobToMs(raw: string | undefined, defaultMinutes: number): number {
  if (raw === undefined || raw.trim() === '') return defaultMinutes * 60_000
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMinutes * 60_000
  return parsed * 60_000
}
