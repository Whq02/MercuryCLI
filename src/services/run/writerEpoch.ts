/**
 * writerEpoch — the DURABLE writer epoch.
 *
 * What the code did: `WRITER_EPOCH = Date.now()` at module load. Which invariant
 * that missed: epochs must be strictly increasing per writer generation, and a
 * wall clock is not. Two processes started inside the same millisecond take the
 * SAME epoch, and a clock stepped backwards (NTP correction, VM resume, a
 * laptop waking in another timezone) hands a LATER writer a LOWER epoch than one
 * that already committed. A fencing token that can go backwards cannot fence:
 * the stale writer looks newer and wins.
 *
 * The epoch is now claimed from a durable counter, bumped once per process on
 * first use and monotonic by construction. The claim rides `defineStore`, so it
 * inherits the kernel's locked read-modify-write — including group commit
 * — and adds no new direct write route (the write-route ratchet would reject
 * one, correctly).
 *
 * The on-disk SHAPE does not change: already stamped `epoch` into every
 * sidecar commit precisely so this could land without reshaping the record a
 * second time. Only where the number comes from changes.
 */
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { join } from 'path'

interface EpochRecord {
  /** Highest epoch handed out. Strictly increasing; never derived from a clock. */
  epoch: number
}

const epochStore = defineStore<EpochRecord, []>({
  name: 'writer-epoch',
  path: () => join(getMercuryHome(), 'writer-epoch.json'),
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as { epoch?: unknown }).epoch === 'number'
      ? { epoch: (raw as { epoch: number }).epoch }
      : null,
  empty: () => ({ epoch: 0 }),
  // A damaged counter must not silently restart at 0 — that would hand out an
  // epoch BELOW ones already stamped into committed sidecars, which is the exact
  // failure this owner exists to prevent. Fail closed and let the caller fall
  // back to the in-memory epoch, which is at least monotonic within this process.
  onReadFailure: 'throw',
})()

/** Process-lifetime fallback: used only until the durable claim resolves, and
 *  if the durable counter is unreadable. Monotonic within this process. */
export const FALLBACK_EPOCH: number = Date.now()

let claimed: Promise<number> | null = null
let resolved: number = FALLBACK_EPOCH

/**
 * Claim this process's epoch — once, memoized. Every later call resolves the
 * same number, so a process has exactly ONE epoch no matter how many owners it
 * writes.
 */
export function writerEpoch(): Promise<number> {
  claimed ??= epochStore
    .mutate(current => ({ epoch: current.epoch + 1 }))
    .then(async () => {
      const next = (await epochStore.read()).epoch
      resolved = next
      return next
    })
    .catch(() => {
      // Unreadable or unwritable counter: keep the in-memory epoch rather than
      // fabricating a durable-looking one. Callers still get a number that rises
      // within this process; what is lost is cross-restart ordering, and that
      // loss is honest instead of silent.
      resolved = FALLBACK_EPOCH
      return FALLBACK_EPOCH
    })
  return claimed
}

/** The epoch resolved so far — the fallback until {@link writerEpoch} settles. */
export function currentWriterEpoch(): number {
  return resolved
}

/** Testing seam: forget the claim so a prover can model a process restart. */
export function _resetWriterEpochForTesting(): void {
  claimed = null
  resolved = FALLBACK_EPOCH
}
