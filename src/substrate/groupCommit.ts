/**
 * groupCommit — THE batching discipline for a cross-process critical section
 *
 *
 * A guarded read-modify-write normally costs one full section per mutation:
 * lock, read, apply, publish, release. That makes the lock cost scale with the
 * number of MUTATIONS rather than the number of BUSY PERIODS, so concurrent
 * writers convoy on it. Measured on this repository's real lock options, 40
 * concurrent writers exhausted proper-lockfile's ~2.6s retry budget and DROPPED
 * 29 of 600 commits outright, p99 2.5s — the status quo was not merely slow
 * under contention, it lost committed work
 *
 *
 * This lane collapses that: everything queued while a section is busy is applied
 * together in the NEXT one — lock once, read once, apply each mutation in order
 * against the same value, publish once.
 *
 * It exists as ONE owner deliberately. The repository has already paid for the
 * alternative: four inline copies of the previous coalescing pattern drifted
 * apart before `substrate/serialGeneration.ts` was extracted to end them. A
 * second hand-rolled batching loop beside this one would repeat that exactly.
 *
 * Four properties are guaranteed here so no consumer has to re-derive them:
 *
 *   ORDERED    mutations apply in acceptance order against the same value, so
 *              each observes its predecessor's result — the semantics a caller
 *              would get by taking the lock itself.
 *   ISOLATED   one mutation throwing rejects only ITSELF; the batch carries on
 *              from the unchanged value so its mates still commit.
 *   DURABLE    results are withheld until AFTER the single publish, so no caller
 *              observes success before its bytes are durable. If the lock, read
 *              or publish fails, the WHOLE batch is rejected — each entry
 *              keeping its own error where it had one, since that diagnosis is
 *              more useful than the batch's.
 *   BOUNDED    a batch holds exactly what accumulated while the previous section
 *              ran; arrivals during a drain belong to the NEXT batch. A hot
 *              writer can therefore neither starve the release nor grow a batch
 *              without limit.
 *
 * Consumers keep their own publication semantics. Note that one publish for N
 * mutations means observers see a revision JUMP rather than a step — for stores
 * that is already first-class (subscribeChanges delivers a provable
 * skippedRevisions catch-up), but a consumer that counts one event per write
 * must be checked before adopting this.
 */

import { flagEnabled } from './flagRegistry.js'

/** One queued mutation awaiting its batch. */
interface Entry<T> {
  apply: (current: T) => Promise<{ next: T; result: unknown }>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export interface GroupCommitLane<T> {
  /**
   * Queue a mutation. Resolves with `result` only once the batch containing it
   * has been published.
   */
  submit: <R>(fn: (current: T) => Promise<{ next: T; result: R }>) => Promise<R>
}

export interface GroupCommitOptions<T, C = void> {
  /** Acquire the cross-process lock; resolve with its release. */
  acquire: () => Promise<() => Promise<void>>
  /** Read the current value INSIDE the lock, with any context publish needs. */
  read: () => Promise<{ value: T; context: C }>
  /** Publish the batched value. Called at most once per batch, and only when
   *  the value actually changed. */
  publish: (next: T, context: C) => Promise<void>
  /** Optional guard immediately before publish — the seam for re-checking lock
   *  ownership at the COMMIT boundary rather than merely at acquisition, since
   *  the mutation callbacks ran in between. Throwing here fails the batch. */
  beforePublish?: () => void
}

/**
 * BOUNDED ROLLOUT (MERCURY_GROUP_COMMIT, default ON, REMOVE after).
 * Batching changes commit TIMING for every durable store at once, so the escape
 * hatch is a one-variable revert to the ungrouped shape — one full critical
 * section per mutation — rather than a redeploy. It gates only the BATCHING: the
 * ordering, isolation and durability-before-settle guarantees are identical in
 * both modes, because turning it off simply makes every batch hold one entry.
 *
 * Read live rather than cached at module load so a doctor/session toggle takes
 * effect without a restart (the repo's authority-toggle honesty rule), and read
 * THROUGH the registry: flagRegistry is the one bounded env reader (a
 * hand-rolled read here puts a second resolver in the tree — caught by the
 * namespace ratchet).
 */
function batchingEnabled(): boolean {
  return flagEnabled('MERCURY_GROUP_COMMIT')
}

export function groupCommitLane<T, C = void>(opts: GroupCommitOptions<T, C>): GroupCommitLane<T> {
  let queue: Array<Entry<T>> = []
  let scheduled = false
  // Never-rejecting, so a failed drain cannot poison the ones behind it.
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    // Claim synchronously: arrivals from here belong to the NEXT drain, which
    // is what bounds the batch.
    scheduled = false
    if (queue.length === 0) return
    // Flag OFF ⇒ a batch of exactly one, which reproduces the ungrouped shape
    // (a full critical section per mutation) without a second code path to keep
    // honest. The remaining entries simply ride the next drain.
    const batch = batchingEnabled() ? queue : queue.splice(0, 1)
    if (batchingEnabled()) queue = []
    else if (queue.length > 0) {
      scheduled = true
      const more = chain.then(drain, drain)
      chain = more.then(
        () => undefined,
        () => undefined,
      )
    }

    let release: (() => Promise<void>) | undefined
    const applied: Array<{ entry: Entry<T>; ok: boolean; value?: unknown; err?: unknown }> = []
    try {
      release = await opts.acquire()
      const { value, context } = await opts.read()
      let current = value
      const initial = current
      for (const entry of batch) {
        try {
          const { next, result } = await entry.apply(current)
          current = next
          applied.push({ entry, ok: true, value: result })
        } catch (err) {
          applied.push({ entry, ok: false, err })
        }
      }
      if (!Object.is(current, initial)) {
        opts.beforePublish?.()
        await opts.publish(current, context)
      }
    } catch (err) {
      const own = new Map(applied.filter(a => !a.ok).map(a => [a.entry, a.err]))
      for (const entry of batch) entry.reject(own.has(entry) ? own.get(entry) : err)
      return
    } finally {
      if (release) {
        try {
          await release()
        } catch {
          // Releasing a lock we no longer own throws. The caller already has the
          // typed failure; masking it with the release error loses the diagnosis.
        }
      }
    }
    for (const a of applied) {
      if (a.ok) a.entry.resolve(a.value)
      else a.entry.reject(a.err)
    }
  }

  return {
    submit: <R>(fn: (current: T) => Promise<{ next: T; result: R }>): Promise<R> =>
      new Promise<R>((resolve, reject) => {
        queue.push({
          apply: fn as unknown as Entry<T>['apply'],
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        // One drain per busy period; everything arriving while it waits rides
        // the same section.
        if (scheduled) return
        scheduled = true
        const op = chain.then(drain, drain)
        chain = op.then(
          () => undefined,
          () => undefined,
        )
      }),
  }
}
