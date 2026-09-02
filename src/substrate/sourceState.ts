// ============================================================================
//  sourceState — the ONE vocabulary for "what happened when we tried to read
//  this source".
//
//  The law already existed and was already applied correctly in places:
//  a source that could not be READ is not the same fact as a source that was
//  read and held nothing. projection.ts honours it for partySeats, treeDigest
//  and the main-run fallback. What was missing was a vocabulary, so seven
//  other sites each invented `catch { return [] }` or `catch { return
//  {state:'none'} }` and flattened a failure into an emptiness. Downstream
//  that renders as "0 open reviews" or "no run exists" — a confident false
//  statement, which is worse than a gap.
//
//  This module is that vocabulary, and it lives in substrate rather than in
//  the workbench because the run domain, the workbench, the resource adapters
//  and ACP all consume it; a workbench home would force services→services
//  cross-imports.
//
//  DURABILITY NOTE: `generation` is
//  PROCESS-SCOPED. It orders observations within one process and means nothing
//  across processes — never compare or persist it as an identity. `observedAt`
//  is the only field with cross-process meaning, so a receipt that records
//  source health drops `generation` rather than reshaping the record.
// ============================================================================

/** Monotonic within this process only — see the durability note above. */
let observationCounter = 0

export interface SourceObservation {
  /** Process-scoped ordering of observations. Never compare across processes. */
  generation: number
  /** Wall clock at observation — the only durable field. */
  observedAt: number
}

/**
 * The five states a source read can be in. They are deliberately NOT
 * collapsible into "have value / don't":
 *
 *   ready        read succeeded and produced a value
 *   empty        read succeeded and the source genuinely holds nothing
 *   stale        the read failed, but a previous good value is still known —
 *                render it WITH its age, never silently as if it were current
 *   recoverable  bytes were obtained and could not be interpreted (torn write,
 *                corrupt JSON, a schema from a newer build)
 *   unavailable  the source could not be observed at all
 */
export type SourceState<T> =
  | (SourceObservation & { state: 'ready'; value: T })
  | (SourceObservation & { state: 'empty' })
  | (SourceObservation & { state: 'stale'; value: T; reason: string })
  | (SourceObservation & { state: 'recoverable'; reason: string })
  | (SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean })

/**
 * The value-free projection of a SourceState, for surfaces that must report
 * HEALTH without carrying the payload — the workbench snapshot's `sources`
 * map, the resource adapters, the ACP extension methods. Structurally
 * identical minus `value`, so it serializes cleanly over a protocol boundary.
 */
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

// The three value-free constructors return their PRECISE arm rather than the
// whole union: each is still assignable to SourceState<T> for any T (they
// carry no payload), and the narrow type is what lets callers like
// classifyReadFailure declare a two-arm result and narrow on `state`.

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

/** Drop the payload, keep the truth. */
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

/**
 * The value where one is known, the caller's fallback otherwise. This is the
 * ONLY sanctioned way to flatten, and it exists so the flattening is explicit
 * at the call site instead of hidden in a catch — a reader can see that a
 * `[]` here may mean "unavailable" and go looking for the health row.
 */
export function valueOr<T>(s: SourceState<T>, fallback: T): T {
  return s.state === 'ready' || s.state === 'stale' ? s.value : fallback
}

/** The reason a source is not fully healthy, where it carries one. */
export function reasonOf(s: SourceHealth): string | undefined {
  return s.state === 'ready' || s.state === 'empty' ? undefined : s.reason
}

/**
 * True when the source was actually OBSERVED, so a count derived from it is a
 * measurement. False for `unavailable` and `recoverable`, where reporting a
 * zero would be a fabrication — that is defect H stated as a predicate, and it
 * is what surfaces should branch on before rendering "0" or "nothing here".
 * `stale` counts as observed: we hold a real prior value and render it WITH
 * its age rather than pretending the source is empty.
 */
export function wasObserved(s: { state: SourceHealth['state'] }): boolean {
  return s.state === 'ready' || s.state === 'empty' || s.state === 'stale'
}

/**
 * Reshape the payload while preserving the observation and its state — the
 * usual need when one layer reads a store and the next projects its rows into
 * a narrower fact. Keeps the failure arms intact instead of re-deriving them.
 */
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

/**
 * Exhaustive fold. Every arm is REQUIRED on purpose: adding a sixth state
 * later should break every consumer that must decide what to render, rather
 * than silently falling into someone's default branch.
 */
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

/**
 * What a failed READ can resolve to — the two arms classifyReadFailure can
 * produce, named so callers narrow on `state` without a default branch.
 * Assignable to SourceState<T> for any T, since neither arm carries a value.
 */
export type ReadFailure =
  | (SourceObservation & { state: 'empty' })
  | (SourceObservation & { state: 'unavailable'; reason: string; retryable: boolean })

/**
 * Classify a filesystem read failure.
 *
 * ENOENT is the ONLY code that means "absent" — everything else is a source we
 * could not observe, and reporting it as empty is precisely defect H. The
 * retryable split is advisory for callers deciding whether to re-read: a
 * permission or type error will not fix itself, whereas exhaustion and I/O
 * errors often do.
 */
export function classifyReadFailure(err: unknown): ReadFailure {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  const detail = err instanceof Error ? err.message : String(err)
  if (code === 'ENOENT') return sourceEmpty()
  const RETRYABLE = new Set(['EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT'])
  // EISDIR/ENOTDIR/EACCES/EPERM and anything unrecognised: the source exists
  // in some form and cannot be read. Unknown codes are reported NON-retryable
  // and carry their code, because guessing "try again" about a failure we do
  // not understand is how a spin loop gets written.
  // Node's own message usually already opens with the code; prefixing
  // unconditionally produced "ENOTDIR: ENOTDIR: not a directory …" in the
  // operator-facing reason.
  const reason = code && !detail.startsWith(code) ? `${code}: ${detail}` : detail
  return sourceUnavailable(reason, code !== undefined && RETRYABLE.has(code))
}
