
let observationCounter = 0

export interface SourceObservation {
  generation: number
  observedAt: number
}

export type SourceState<T> =
  | (SourceObservation & { state: 'ready'; value: T })
  | (SourceObservation & { state: 'empty' })
  | (SourceObservation & { state: 'stale'; value: T; reason: string })
  | (SourceObservation & { state: 'recoverable'; reason: string })
  | (SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean })

export type SourceHealth =
  | (SourceObservation & { state: 'ready' })
  | (SourceObservation & { state: 'empty' })
  | (SourceObservation & { state: 'stale'; reason: string })
  | (SourceObservation & { state: 'recoverable'; reason: string })
  | (SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean })

function observe(): SourceObservation {
  observationCounter += 1
  return { generation: observationCounter, observedAt: Date.now() }
}

export function sourceReady<T>(value: T): SourceState<T> {
  return { ...observe(), state: 'ready', value }
}


export function sourceEmpty(): SourceObservation & { state: 'empty' } {
  return { ...observe(), state: 'empty' }
}

export function sourceStale<T>(value: T, reason: string): SourceState<T> {
  return { ...observe(), state: 'stale', value, reason }
}

export function sourceRecoverable(
  reason: string,
): SourceObservation & { state: 'recoverable'; reason: string } {
  return { ...observe(), state: 'recoverable', reason }
}

export function sourceUnavailable(
  reason: string,
  retryable = false,
): SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean } {
  return { ...observe(), state: 'unavailable', reason, retryable }
}

export function healthOf(s: SourceState<unknown>): SourceHealth {
  switch (s.state) {
    case 'ready':
      return { generation: s.generation, observedAt: s.observedAt, state: 'ready' }
    case 'empty':
      return { generation: s.generation, observedAt: s.observedAt, state: 'empty' }
    case 'stale':
      return {
        generation: s.generation,
        observedAt: s.observedAt,
        state: 'stale',
        reason: s.reason,
      }
    case 'recoverable':
      return {
        generation: s.generation,
        observedAt: s.observedAt,
        state: 'recoverable',
        reason: s.reason,
      }
    case 'unavailable':
      return {
        generation: s.generation,
        observedAt: s.observedAt,
        state: 'unavailable',
        reason: s.reason,
        retryable: s.retryable,
      }
  }
}

export function valueOr<T>(s: SourceState<T>, fallback: T): T {
  return s.state === 'ready' || s.state === 'stale' ? s.value : fallback
}

export function reasonOf(s: SourceHealth): string | undefined {
  return s.state === 'ready' || s.state === 'empty' ? undefined : s.reason
}

export function wasObserved(s: { state: SourceHealth['state'] }): boolean {
  return s.state === 'ready' || s.state === 'empty' || s.state === 'stale'
}

export function mapSourceValue<A, B>(s: SourceState<A>, f: (value: A) => B): SourceState<B> {
  switch (s.state) {
    case 'ready':
      return { generation: s.generation, observedAt: s.observedAt, state: 'ready', value: f(s.value) }
    case 'stale':
      return {
        generation: s.generation,
        observedAt: s.observedAt,
        state: 'stale',
        value: f(s.value),
        reason: s.reason,
      }
    default:
      return s
  }
}

export function foldSourceState<T, R>(
  s: SourceState<T>,
  on: {
    ready: (value: T, o: SourceObservation) => R
    empty: (o: SourceObservation) => R
    stale: (value: T, reason: string, o: SourceObservation) => R
    recoverable: (reason: string, o: SourceObservation) => R
    unavailable: (reason: string, retryable: boolean, o: SourceObservation) => R
  },
): R {
  switch (s.state) {
    case 'ready':
      return on.ready(s.value, s)
    case 'empty':
      return on.empty(s)
    case 'stale':
      return on.stale(s.value, s.reason, s)
    case 'recoverable':
      return on.recoverable(s.reason, s)
    case 'unavailable':
      return on.unavailable(s.reason, s.retryable, s)
  }
}

export type ReadFailure =
  | (SourceObservation & { state: 'empty' })
  | (SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean })

export function classifyReadFailure(err: unknown): ReadFailure {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  const detail = err instanceof Error ? err.message : String(err)
  if (code === 'ENOENT') return sourceEmpty()
  const RETRYABLE = new Set(['EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT'])
  const reason = code && !detail.startsWith(code) ? `${code}: ${detail}` : detail
  return sourceUnavailable(reason, code !== undefined && RETRYABLE.has(code))
}
