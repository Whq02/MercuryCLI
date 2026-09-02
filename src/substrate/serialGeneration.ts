// ============================================================================
//  serialGeneration — the ONE serial, generation-coalescing lane.
//
//  Four inlined copies of this algorithm existed before this module, and no
//  shared owner: fileStore's per-path `opChain`, the MCP server registry's
//  per-slot chain with generation lineage, the MCP client's `writeChain`, and
//  the workbench's `pokeWorkbench` trailing-rerun coalescer. They agree on the
//  shape and disagree on what happens when the work fails, which is exactly
//  where the run coordinator's durability defects lived. This is that shape
//  extracted once, with the failure semantics made explicit.
//
//  The contract:
//    · ACCEPT records a new generation. Generations are monotonic; only the
//      NEWEST accepted value is ever committed, so a burst coalesces.
//    · COMMIT runs serially — one at a time, never concurrently — so an older
//      value can never land after a newer one.
//    · A TRAILING COMMIT is guaranteed: a generation accepted while a commit
//      is in flight always gets its own commit afterwards. This is the
//      property `if (pending) return` silently gives up.
//    · `committed` advances ONLY when the matching generation actually
//      committed. Nothing is marked clean in advance of the work succeeding.
//    · A failed commit leaves its generation ACCEPTED-BUT-UNCOMMITTED and
//      reports `degraded` with the reason and the attempt count. The next
//      settle() retries the same or a newer generation. Failure is a state,
//      not a swallowed exception.
//    · RELEASE is terminal: no further commits are started, and settle()
//      reports whatever the final state was.
//
//  Pure and dependency-free — no timers, no IO, no logging. Scheduling policy
//  belongs to the consumer (the run coordinator debounces; the workbench
//  pokes on events), because the right coalescing window is a property of the
//  event source, not of serialization.
// ============================================================================

export type LaneState = 'clean' | 'pending' | 'settled' | 'degraded'

export interface LaneSettlement {
  state: LaneState
  /** Newest generation handed to accept(). */
  accepted: number
  /** Newest generation that actually committed. */
  committed: number
  /** Present only in the degraded state. */
  reason?: string
  /** Consecutive failed commit attempts for the outstanding generation. */
  attempts: number
  released: boolean
}

export interface SerialGenerationLane<T> {
  /** Record a new accepted generation; returns its number. */
  accept: (value: T) => number
  /** Start the pump without waiting for it (fire-and-observe via state()). */
  poke: () => void
  /**
   * Run until the newest accepted generation has committed, or until a commit
   * fails. Resolves with the resulting settlement — it never rejects, because
   * a persistence failure is reported, not thrown at an unrelated caller.
   */
  settle: () => Promise<LaneSettlement>
  /** Stop accepting work. Any commit already in flight still completes. */
  release: () => Promise<LaneSettlement>
  state: () => LaneSettlement
}

export interface SerialGenerationOptions<T> {
  /** Diagnostic name (settlement reasons, proof output). */
  name: string
  /** Commit one generation durably. Rejecting marks the lane degraded. */
  commit: (value: T, ctx: { generation: number }) => Promise<void>
}

/** Bound on retry rounds inside one settle() call — a lane that cannot make
 *  progress reports degraded rather than spinning. */
const MAX_SETTLE_ROUNDS = 8

/**
 * Bound on commits inside ONE pump(). Without it the trailing-commit loop is
 * unbounded: it re-reads `accepted` after every await, so a producer that
 * accepts at least one generation per commit keeps it running forever and the
 * promise pump() returned never resolves — which would make settle(), flush(),
 * drain() and the awaited terminal drain in the turn generator's finally hang,
 * despite MAX_SETTLE_ROUNDS appearing to bound them. Exiting on the budget
 * hands control back to settle(), whose rounds preserve the trailing-commit
 * guarantee and which then reports `pending` truthfully rather than blocking.
 */
const MAX_COMMITS_PER_PUMP = 64

export function serialGenerationLane<T>(
  opts: SerialGenerationOptions<T>,
): SerialGenerationLane<T> {
  let accepted = 0
  let committed = 0
  let pendingValue: T | null = null
  let running: Promise<void> | null = null
  /** True from before the pump body starts until its finally runs. */
  let active = false
  let reason: string | undefined
  let attempts = 0
  let released = false

  const state = (): LaneSettlement => {
    const base = { accepted, committed, attempts, released }
    if (reason !== undefined) return { state: 'degraded', reason, ...base }
    if (accepted === 0) return { state: 'clean', ...base }
    if (committed < accepted) return { state: 'pending', ...base }
    return { state: 'settled', ...base }
  }

  const pump = (): Promise<void> => {
    // `active` is the guard, NOT the promise handle. An async function whose
    // body completes without ever awaiting runs its `finally` SYNCHRONOUSLY —
    // before the assignment that stores its promise. Guarding on the handle
    // therefore latched: a pump with nothing to do (accepted === 0, or already
    // caught up, or released) cleared a handle that had not been set yet, the
    // assignment then wrote an already-resolved promise, and every later pump
    // short-circuited on it. The lane went permanently silent — reporting
    // `pending` with zero attempts, which is neither committed nor degraded,
    // so nothing surfaced it. Setting the flag before the body starts and
    // clearing it in the body's own finally has no such window.
    if (active && running) return running
    active = true
    running = (async () => {
      let commitsThisPump = 0
      try {
        // The trailing-commit loop: re-read `accepted` after every await, so a
        // generation that arrived DURING a commit gets its own commit rather
        // than being dropped. Bounded per pump so a producer that outruns the
        // writer cannot hold this promise open forever.
        while (!released && committed < accepted && pendingValue !== null) {
          if (commitsThisPump >= MAX_COMMITS_PER_PUMP) return
          commitsThisPump += 1
          const generation = accepted
          const value = pendingValue
          try {
            await opts.commit(value, { generation })
            committed = generation
            reason = undefined
            attempts = 0
          } catch (e) {
            // The generation stays accepted-but-uncommitted on purpose: the
            // next settle() retries it, and until then the lane reports the
            // failure instead of pretending the value is durable.
            attempts += 1
            reason = `[${opts.name}] ${e instanceof Error ? e.message : String(e)}`
            return
          }
        }
      } finally {
        active = false
      }
    })()
    return running
  }

  const settle = async (): Promise<LaneSettlement> => {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      await pump()
      if (released) break
      if (reason !== undefined) break
      if (committed >= accepted) break
    }
    return state()
  }

  return {
    accept: value => {
      accepted += 1
      pendingValue = value
      if (released) {
        // A released lane starts no further commits, so this generation can
        // never land. Recording it silently would leave the lane reporting
        // `pending` forever with nothing to explain why; the caller gets a
        // degraded receipt instead, which is the contract for a value that
        // cannot be made durable.
        reason = `[${opts.name}] generation ${accepted} was accepted after release and cannot be committed`
      }
      return accepted
    },
    poke: () => {
      if (released) return
      void pump()
    },
    settle,
    release: async () => {
      // A commit already in flight is allowed to finish — cancelling it would
      // be the loss this module exists to prevent.
      if (running) await running
      released = true
      return state()
    },
    state,
  }
}
