/**
 * FileStore<T> — the reactive substrate kernel (HANDOFF-REACTIVE-SUBSTRATE Phase 1).
 *
 * ONE implementation of the four properties every JSON store in this harness needs,
 * replacing five hand-rolled divergent copies (leases / mailbox / cron / tasks /
 * daemon sidecars):
 *
 *   1. LOCKED READ-MODIFY-WRITE — proper-lockfile (via utils/lockfile) around every
 *      mutation, with ONE retry policy (the tasks.ts budget, the most generous of the
 *      three that existed: ~10-way concurrent writers wait ~2.6s worst case).
 *   2. ATOMIC PUBLISH — tmp + rename in the store's own directory (the leaseGlob
 *      pattern), everywhere. No truncate-in-place, so a lock-free reader can NEVER
 *      see a torn file. This is also what makes SUBSCRIBE safe: a watcher event on
 *      a renamed-in file is an event on a COMPLETE file.
 *   3. VALIDATE-ON-READ with a DECLARED fail policy — `decode` turns raw parsed JSON
 *      into a valid T or null; what happens on corrupt/unreadable input is a declared
 *      per-store property (`onReadFailure: 'empty' | 'throw'`), not the accident of a
 *      `catch {}`. Missing file (ENOENT) is always `empty()` — an absent store is an
 *      empty store, never an error. Schema versioning: `schemaVersion` is stamped as
 *      an additive `_v` key on object-shaped stores (old readers ignore unknown keys,
 *      so mixed-version sessions stay compatible); array-shaped stores (the mailbox)
 *      deliberately stay bare arrays — wrapping them would break any concurrently
 *      running older build, and their elements are validated individually by `decode`.
 *   4. SUBSCRIBE — chokidar-backed change notification (cross-process), debounced,
 *      plus a zero-latency in-process fan-out on our own publishes. Emission is
 *      content-deduped (raw-string compare) so a self-triggered watcher event never
 *      double-fires. If the watch engine fails to start, a documented POLLING
 *      FALLBACK (`pollFallbackMs`, default 1000ms) keeps subscriptions honest.
 *
 * Readers never block (leaseGlob doctrine): `read()` takes no lock — atomic publish
 * makes torn reads impossible, so the worst case is reading the value from one
 * publish ago. All timers/watchers are unref'd/non-persistent so the kernel never
 * holds a process open (the daemon has its own explicit keep-alive anchor).
 *
 *   5. REVISIONED SNAPSHOTS — every successful
 *      mutation of an OBJECT-shaped store advances a monotonic `_rev` stamp
 *      (revision · writerId · operationId · committedAt · digest) beside `_v`,
 *      committed in the SAME atomic rename as the value. `readResult()` is the
 *      typed read (ready ⇒ value + revision · missing ⇒ empty · recoverable ⇒
 *      reason + optional lastGood — NEVER silently empty), and
 *      `subscribeChanges()` delivers {value, revision, cause, skippedRevisions}
 *      so a subscriber can PROVE whether it observed the next commit or
 *      skipped ahead (a coalesced/missed event arrives as ONE `catch-up`
 *      emission with the provable skip count). Bare-array stores stay bare on
 *      disk (mixed-version compat); their revision derives from the declared
 *      `revisionOf` (per-element sequences) or stays null — honestly reported,
 *      never fabricated. The FC5 guard: a locked mutation that reads
 *      unreadable/invalid bytes QUARANTINES the damaged copy (bounded,
 *      clearly-named sibling + the recovery ledger — storeRecovery.ts) and
 *      resumes from the runtime's last known committed value when one exists,
 *      before anything is republished; 'throw'-policy stores abort unchanged.
 *      SCHEMA MIGRATION stays the `_v` + decode contract: `decode` accepts
 *      every historical shape (it IS the explicit, versioned, idempotent
 *      migration), and the next locked mutation republishes the current shape
 *      through the durable primitive.
 */

import { resolveWatchRoot } from '../utils/watchRoot.js'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { FSWatcher } from 'chokidar'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { groupCommitLane } from './groupCommit.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { durableAtomicPublish } from './durablePublish.js'
import { quarantineDamagedStore } from './storeRecovery.js'
import {
  nextRevision,
  parseRevision,
  payloadDigest,
  REVISION_KEY,
  skippedBetween,
  type StoreChange,
  type StoreChangeCause,
  type StoreReadResult,
  type StoreRevision,
} from './storeRevision.js'

export type {
  StoreChange,
  StoreChangeCause,
  StoreReadResult,
  StoreRevision,
} from './storeRevision.js'

/**
 * The ONE lock retry policy (handoff Phase 1: mailbox/leases/tasks used 10/20/30).
 * Sized for ~10+ concurrent swarm agents whose critical section does a read + a
 * write (~50-100ms on slow disks): retries=30 gives ~2.6s of total patience before
 * failing loudly. `randomize` is LOAD-BEARING: without jitter, contenders that
 * start together share an identical deterministic backoff schedule, probe at the
 * same instants, and drain exactly one per max-timeout round — a measured 40-way
 * convoy exhausted 9 contenders' budgets while the lock sat free 97% of the time.
 * (In-process contention never reaches this policy at all — the kernel serializes
 * same-process ops on a per-path chain below.)
 */
export const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    randomize: true,
  },
  /**
   * How long a lock may go un-refreshed before another process may treat it as
   * abandoned. Left UNDECLARED, cross-process
   * correctness rests on proper-lockfile's implicit default with nothing in
   * the repository saying what the contract was. A critical section here is
   * read → mutate → publish, normally well under 100ms on a slow disk; ten
   * seconds is two orders of magnitude of headroom before a holder looks
   * abandoned.
   */
  stale: 10_000,
  /**
   * Refresh cadence for a live holder — comfortably inside `stale`, so a
   * merely-busy holder is never mistaken for a dead one. (The case where a
   * holder is descheduled past `stale` and two processes then each believe
   * they hold the lock is the repo's open STALE-STEAL-UNDER-DESCHEDULE row;
   * closes it with the durable-state authority. What stage 1 does is
   * make the loss DETECTABLE instead of silent.)
   */
  update: 2_000,
  /**
   * Ownership loss is RECORDED, not thrown. proper-lockfile's own default
   * rethrows from its refresh timer, which surfaces as an unhandled exception
   * on an unrelated stack; the critical section, which is the only code that
   * can act on the loss, learns nothing. This records it so the holder refuses
   * to publish (see assertStillHeld).
   */
  onCompromised: (err: Error): void => {
    logForDebugging(`[fileStore] lock compromised: ${err.message}`, { level: 'warn' })
  },
} as const

/** Raised when a locked mutation discovers it no longer owns its lock. */
export class StoreLockLostError extends Error {
  constructor(
    public readonly storePath: string,
    public readonly detail: string,
  ) {
    super(`[fileStore] lock ownership lost for ${storePath} (${detail}) — mutation not published`)
    this.name = 'StoreLockLostError'
  }
}

/** Paths whose lock proper-lockfile reported compromised since acquisition. */
const compromisedLocks = new Set<string>()

/** Per-path lock options: the declared contract plus a scoped compromise
 *  recorder, so the holder of THIS lock is the one who learns it was lost. */
function storeLockOptions(path: string): Record<string, unknown> {
  return {
    ...STORE_LOCK_OPTIONS,
    onCompromised: (err: Error): void => {
      compromisedLocks.add(path)
      logForDebugging(`[fileStore] lock compromised for ${path}: ${err.message}`, { level: 'warn' })
    },
  }
}

/**
 * Where proper-lockfile actually puts this store's lock. The library resolves
 * the real path by default, so a store reached through a FILE symlink locks at
 * `${realpath(file)}.lock`, not `${file}.lock`.
 *
 * Resolving it the same way here — rather than PINNING `lockfilePath` to the
 * literal spelling, which was the first attempt — matters because the pin
 * would have keyed the lock artefact by the caller's spelling while the
 * library still keyed exclusion by the real path: two spellings of one file
 * would each acquire their own lock and both publish. That trades this guard's
 * fail-CLOSED mistake (refusing every publish on a symlinked store, loud and
 * lossless) for a fail-OPEN one (a silent lost update), which is the worse
 * side to be wrong on. Verified with two real processes: pinned, both
 * acquired; default, the second was refused with ELOCKED.
 *
 * ensureExists(path) has already run when this is called, so realpath cannot
 * fail for absence; any other resolution error falls back to the literal
 * spelling, which is what the library uses when it cannot resolve either.
 */
function lockArtefactPath(path: string): string {
  try {
    return `${realpathSync(path)}.lock`
  } catch {
    return `${path}.lock`
  }
}

/**
 * Refuse to publish when this holder no longer owns its lock. Two independent
 * signals: proper-lockfile's own compromise callback (a lock that was stolen
 * or expired under us), and the direct absence of the lock directory (a lock
 * that was removed outright). Publishing after either one is a lost update
 * reported as a success, which is the failure this guard exists to prevent.
 */
function assertStillHeld(path: string): void {
  if (compromisedLocks.has(path)) {
    throw new StoreLockLostError(path, 'the lock was reported compromised')
  }
  if (!existsSync(lockArtefactPath(path))) {
    throw new StoreLockLostError(path, 'the lock is no longer present')
  }
}

/** Additive schema-version key stamped on object-shaped stores. */
export const VERSION_KEY = '_v'

/** Default debounce for watcher-driven emissions (coalesces write bursts). */
const DEFAULT_WATCH_DEBOUNCE_MS = 25

/** Default poll interval for the documented no-watcher fallback. */
const DEFAULT_POLL_FALLBACK_MS = 1000

/**
 * Atomically publish `contents` to `path` — DELEGATES to the one durable
 * publication primitive (durableAtomicPublish: exclusive collision-free temp,
 * fsync-before-rename, dir fsync after; typed failure phases). Kept as the
 * kernel's public helper for stores with their own file-per-record layout
 * (tasks.ts task bodies) so every caller inherits the durability contract.
 */
export async function publishAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await durableAtomicPublish(path, contents)
}

/** Declared read-failure policy: what a corrupt/unreadable store degrades to. */
export type ReadFailurePolicy = 'empty' | 'throw'

export interface StoreConfig<T, A extends unknown[]> {
  /** Diagnostic name (log lines, tmp guards). */
  name: string
  /** Resolve the store's absolute file path from accessor args (lazily, per call —
   *  config dirs move under tests, so nothing is captured at define time). */
  path: (...args: A) => string
  /** Monotonic schema version, stamped as `_v` on object-shaped encodes. */
  schemaVersion: number
  /** Validate raw parsed JSON (any historical shape) into a T, or null = invalid. */
  decode: (raw: unknown) => T | null
  /** Encode a T for disk. Defaults to identity. The kernel stamps `_v` after this
   *  when the result is a plain (non-array) object. */
  encode?: (value: T) => unknown
  /** The empty store value (missing file, and the 'empty' failure policy). */
  empty: () => T
  /** DECLARED policy for corrupt / non-ENOENT-unreadable stores. */
  onReadFailure: ReadFailurePolicy
  /** Watcher emission debounce (default 25ms). */
  watchDebounceMs?: number
  /** Poll interval for the documented fallback when the watch engine is
   *  unavailable (default 1000ms). */
  pollFallbackMs?: number
  /**
   * Steady-state poll FLOOR that runs ALONGSIDE a healthy watcher (opt-in;
   * absent ⇒ watcher-only, the prior behavior). A cross-process atomic-rename
   * write can silently miss the platform watch engine (measured live
   * a worker's escalate sat 39s in the coordinator's inbox —
   * three sibling writes that morning delivered in ~30ms — until the next
   * socket-side write flushed it; nothing errors, so the error→poll fallback
   * never engages). Content-dedup makes each tick a no-op unless bytes really
   * changed, so the floor turns "stranded until the next unrelated write"
   * into "delivered within one floor interval" for the price of one small
   * read per interval. Set it on stores whose subscribers are load-bearing
   * consumers of OTHER PROCESSES' writes (the teammate mailbox bus); leave it
   * off for stores only their writer reads.
   */
  pollFloorMs?: number
  /**
   * Revision derivation for BARE-ARRAY stores, which cannot carry an in-band
   * `_rev` stamp (object-wrapping would break older concurrent builds).
   * Return a monotonic number derived from the VALUE itself (e.g. the max
   * per-element sequence). Absent ⇒ array revisions are null (legacy:
   * content-dedup only, honestly reported to subscribers).
   */
  revisionOf?: (value: T) => number
}

export interface StoreHandle<T> {
  /** The resolved absolute path (diagnostics / proofs). */
  readonly path: string
  /** Lock-free validated read. ENOENT ⇒ empty(); corrupt ⇒ per onReadFailure. */
  read(): Promise<T>
  /** Typed lock-free read: ready (value + revision) · missing (empty) ·
   *  recoverable (reason + optional last-good witness) — NEVER a silent
   *  empty over damaged bytes. */
  readResult(): Promise<StoreReadResult<T>>
  /** Locked read-modify-write with a result: lock → read → fn → atomic publish. */
  update<R>(
    fn: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>,
  ): Promise<R>
  /** Locked read-modify-write without a result. */
  mutate(fn: (current: T) => T | Promise<T>): Promise<void>
  /** Locked whole-value replace (atomic publish). */
  write(value: T): Promise<void>
  /**
   * Subscribe to changes. Fires (debounced, content-deduped) on cross-process file
   * changes and immediately on in-process publishes. `immediate: true` (default)
   * also fires once with the current value on the next microtask. Returns an
   * unsubscribe fn; the underlying watcher stops when the last listener leaves.
   */
  subscribe(
    listener: (value: T) => void,
    opts?: { immediate?: boolean },
  ): () => void
  /**
   * Revision-aware subscription: every emission carries the committed
   * revision it observed, its cause (local-commit · watch · catch-up ·
   * recovery), and the PROVABLE skipped-revision count since this runtime's
   * last observation. A skipped/coalesced commit arrives as one `catch-up`
   * emission of the latest committed snapshot. Same lifecycle as subscribe().
   */
  subscribeChanges(
    listener: (change: StoreChange<T>) => void,
    opts?: { immediate?: boolean },
  ): () => void
  /** Proof/diagnostic seam: live runtime resource counts for this path
   *  (listeners, watcher/timer liveness, emission seq, watermarks). Never
   *  product logic. */
  _statsForProofs(): {
    listeners: number
    watcher: boolean
    watcherStarting: boolean
    pollTimer: boolean
    pollFloorTimer: boolean
    debounceTimer: boolean
    emissionSeq: number
    publishEpoch: number
    lastSeenRevision: number | null
    lastEmittedOpId: string | null
  }
}

type Runtime = {
  listeners: Set<(change: StoreChange<unknown>) => void>
  watcher: FSWatcher | null
  watcherStarting: Promise<void> | null
  pollTimer: ReturnType<typeof setInterval> | null
  /** The opt-in steady poll running ALONGSIDE a healthy watcher (pollFloorMs) —
   *  distinct from pollTimer, which REPLACES a missing/failed watcher. */
  pollFloorTimer: ReturnType<typeof setInterval> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  lastEmittedRaw: string | null
  /** The highest committed revision this RUNTIME has observed (emissions +
   *  local commits + the first immediate read). null until any stamped
   *  revision is seen — skips are only ever computed when PROVABLE. */
  lastSeenRevision: number | null
  /** The operationId of this runtime's own last commit — the watcher-echo
   *  dedup key that raw-byte comparison alone cannot provide. */
  lastEmittedOpId: string | null
  /** Monotonic per-runtime emission counter — bumps on EVERY listener
   *  fan-out (local publish or watcher-driven). Never-old-after-new is
   *  runtime-wide, held by TWO fences: the subscribe-immediate read
   *  compares against THIS counter so a slow initial read can never
   *  deliver OLD state after a newer emission already reached the
   *  listener, and the watcher/poll read path is
   *  fenced by `publishEpoch` below so a read opened before a local
   *  publish can never fan its stale bytes out after the newer value. */
  emissionSeq: number
  /** Synchronous publication epoch — advances on EVERY accepted local
   *  publication, in the same synchronous block that latches the raw
   *  bytes. emitIfChanged captures it before its disk read and DISCARDS
   *  the read when the epoch moved (retrying against the post-publication
   *  disk state), so a stale read never fans out, never regresses the
   *  lastEmittedRaw latch, and never arms the opId dedup against the
   *  corrective re-read (the sticky-staleness class). */
  publishEpoch: number
  /** ONE running emit read + ONE dirty trailing read per runtime: a call
   *  arriving while a read is in flight marks the trailing flag and the
   *  running loop re-reads once after — overlapping reads of different
   *  file generations can never resolve out of order. */
  emitRunning: boolean
  emitDirty: boolean
  /** Same-process mutations serialize on this chain, so only ONE in-process
   *  contender ever competes for the cross-process fs lock at a time. */
  opChain: Promise<void>
}

/** Proof seam (blocked-read fault injection for the ordering prover):
 *  when set, every emitIfChanged read parks on the gate BETWEEN the disk
 *  read resolving and the epoch-fence check — the exact window a local
 *  publish can land in. Never product logic; null in production. */
let emitReadGateForProofs: (() => Promise<void>) | null = null
export function _setEmitReadGateForProofs(
  gate: (() => Promise<void>) | null,
): void {
  emitReadGateForProofs = gate
}


/**
 * Define a store family. Returns an accessor resolving args → a cached per-path
 * {@link StoreHandle}, so every consumer of the same file shares one watcher and
 * one in-process fan-out.
 */
export function defineStore<T, A extends unknown[] = []>(
  cfg: StoreConfig<T, A>,
): (...args: A) => StoreHandle<T> {
  const handles = new Map<string, StoreHandle<T>>()
  const runtimes = new Map<string, Runtime>()

  const decodeRaw = (raw: string): T => {
    const parsed = jsonParse(raw) as unknown
    const value = cfg.decode(parsed)
    if (value === null) throw new Error(`[${cfg.name}] store failed validation`)
    return value
  }

  /** The revision carried by decoded state: the in-band `_rev` stamp for
   *  object stores; the declared `revisionOf` derivation for arrays; null
   *  for legacy/unstamped bytes (honest, never fabricated). */
  const revisionFor = (parsed: unknown, value: T): StoreRevision | null => {
    const stamped = parseRevision(parsed)
    if (stamped) return stamped
    if (cfg.revisionOf) {
      const n = cfg.revisionOf(value)
      if (Number.isFinite(n) && n > 0) {
        return {
          revision: n,
          writerId: 'derived',
          operationId: '',
          committedAt: '',
          digest: '',
        }
      }
    }
    return null
  }

  /** The typed read + the raw bytes (internal: the locked path quarantines
   *  the raw bytes on a recoverable result before mutating past them). */
  const readResultAt = async (
    path: string,
    rt: Runtime | null,
  ): Promise<{ result: StoreReadResult<T>; raw: string | null }> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (e) {
      if (getErrnoCode(e) === 'ENOENT') {
        return { result: { state: 'missing', value: cfg.empty() }, raw: null }
      }
      return {
        result: {
          state: 'recoverable',
          reason: `store unreadable: ${e}`,
          path,
          ...lastGoodOf(rt),
        },
        raw: null,
      }
    }
    try {
      const parsed = jsonParse(raw) as unknown
      const value = cfg.decode(parsed)
      if (value === null) throw new Error(`[${cfg.name}] store failed validation`)
      return {
        result: { state: 'ready', value, revision: revisionFor(parsed, value) },
        raw,
      }
    } catch (e) {
      return {
        result: {
          state: 'recoverable',
          reason: `store invalid: ${e}`,
          path,
          ...lastGoodOf(rt),
        },
        raw,
      }
    }
  }

  /** The runtime's last known committed value, as a spreadable lastGood arm
   *  (an in-memory witness — never fabricated from the damaged disk). */
  const lastGoodOf = (rt: Runtime | null): { lastGood?: T } => {
    if (!rt?.lastEmittedRaw) return {}
    try {
      return { lastGood: decodeRaw(rt.lastEmittedRaw) }
    } catch {
      return {}
    }
  }

  let readDegradeRecorded = false
  const applyFailure = (e: unknown, path: string): T => {
    if (cfg.onReadFailure === 'throw') throw e
    // Declared fail-open: degrade to empty, but WARN (doctrine — a
    // degraded store must be discoverable, never silent) AND record ONE
    // ledger receipt per store per process (: the doctor's
    // store-quarantines check surfaces it; the damaged bytes stay in place
    // until the next mutation quarantines them).
    logForDebugging(
      `[${cfg.name}] store read failed, degrading to empty (declared fail-open): ${e}`,
      { level: 'warn' },
    )
    if (!readDegradeRecorded) {
      readDegradeRecorded = true
      void import('./storeRecovery.js')
        .then(m => m.recordStoreReadDegradation({ store: cfg.name, path, reason: String(e) }))
        .catch(() => {})
    }
    return cfg.empty()
  }

  const readAt = async (path: string): Promise<T> => {
    const { result } = await readResultAt(path, runtimes.get(path) ?? null)
    if (result.state === 'recoverable') {
      return applyFailure(new Error(result.reason), path)
    }
    return result.value
  }

  /** Encode for disk WITHOUT a revision (the ensureExists first-create).
   *  Object-shaped payloads are stamped `_v`; arrays stay bare. */
  const encodeValue = (value: T): string => {
    const encoded = (cfg.encode ?? (v => v as unknown))(value)
    const stamped =
      encoded !== null &&
      typeof encoded === 'object' &&
      !Array.isArray(encoded)
        ? { ...(encoded as Record<string, unknown>), [VERSION_KEY]: cfg.schemaVersion }
        : encoded
    return jsonStringify(stamped, null, 2) + '\n'
  }

  const getRuntime = (path: string): Runtime => {
    let rt = runtimes.get(path)
    if (!rt) {
      rt = {
        listeners: new Set(),
        watcher: null,
        watcherStarting: null,
        pollTimer: null,
        pollFloorTimer: null,
        debounceTimer: null,
        lastEmittedRaw: null,
        lastSeenRevision: null,
        lastEmittedOpId: null,
        emissionSeq: 0,
        publishEpoch: 0,
        emitRunning: false,
        emitDirty: false,
        opChain: Promise.resolve(),
      }
      runtimes.set(path, rt)
    }
    return rt
  }

  /** Read + emit to listeners iff raw content changed since the last
   *  emission. Serialized per runtime (one running read + one dirty
   *  trailing read) and epoch-fenced against local publications — the
   *  watcher/poll half of the never-old-after-new invariant (the
   *  subscribe-immediate half is the emissionSeq guard below). */
  const emitIfChanged = async (path: string, rt: Runtime): Promise<void> => {
    if (rt.listeners.size === 0) return
    if (rt.emitRunning) {
      rt.emitDirty = true
      return
    }
    rt.emitRunning = true
    try {
      do {
        rt.emitDirty = false
        await emitOnce(path, rt)
      } while (rt.emitDirty && rt.listeners.size > 0)
    } finally {
      rt.emitRunning = false
    }
  }

  const emitOnce = async (path: string, rt: Runtime): Promise<void> => {
    const epochAtRead = rt.publishEpoch
    let raw: string | null
    try {
      raw = await readFile(path, 'utf-8')
    } catch (e) {
      raw = getErrnoCode(e) === 'ENOENT' ? null : rt.lastEmittedRaw // unreadable: skip
      if (raw === rt.lastEmittedRaw && raw !== null) return
    }
    if (emitReadGateForProofs) await emitReadGateForProofs()
    // THE EPOCH FENCE: a local publication landed while this read was in
    // flight, so whatever bytes it holds are at best one commit old.
    // Discard WITHOUT touching any latch (a stale latch regression is what
    // made staleness sticky: the opId dedup then swallowed the corrective
    // re-read) and go around once more against the post-publication disk.
    if (rt.publishEpoch !== epochAtRead) {
      rt.emitDirty = true
      return
    }
    // All listeners left while the read was in flight (stopWatching already
    // reset the latches for a fresh re-subscribe baseline) — never re-latch.
    if (rt.listeners.size === 0) return
    if (raw === rt.lastEmittedRaw) return
    let value: T
    let revision: StoreRevision | null = null
    try {
      if (raw === null) {
        value = cfg.empty()
      } else {
        const parsed = jsonParse(raw) as unknown
        const decoded = cfg.decode(parsed)
        if (decoded === null) throw new Error(`[${cfg.name}] store failed validation`)
        value = decoded
        revision = revisionFor(parsed, decoded)
      }
    } catch (e) {
      // Never let a corrupt intermediate state crash a subscriber loop; the next
      // valid publish re-emits. (With atomic publish this is transition-window
      // only — an old writer mid-migration.)
      logForDebugging(`[${cfg.name}] subscribe read failed, skipping emit: ${e}`)
      return
    }
    // Self-echo dedup by OPERATION ID (stronger than raw bytes: the watcher's
    // echo of this runtime's own commit can never double-fire even if the
    // bytes were normalized differently along the way). Safe to latch here:
    // the epoch fence above guarantees these bytes are not older than the
    // publication that armed the opId.
    if (revision?.operationId && revision.operationId === rt.lastEmittedOpId) {
      rt.lastEmittedRaw = raw
      return
    }
    rt.lastEmittedRaw = raw
    // Provable skip accounting: a coalesced/missed commit arrives as ONE
    // catch-up emission of the latest committed snapshot. The watermark
    // ADOPTS the delivered revision (assignment, not Math.max): the race
    // that produced in-process backward revisions is closed by the fence,
    // so a genuinely backward stamp is a disk-authority reset (recreate by
    // another process) — clamping to the old high watermark would silently
    // zero every skip count from then on.
    const skipped = skippedBetween(rt.lastSeenRevision, revision)
    if (revision) rt.lastSeenRevision = revision.revision
    fanOut(rt, {
      value,
      revision,
      cause: skipped > 0 ? 'catch-up' : 'watch',
      skippedRevisions: skipped,
    })
  }

  /** Deliver a change to every listener (exceptions isolated per listener)
   *  and stamp the emission. The ONE fan-out path — local publishes and
   *  watcher-driven emissions both come through here so the emission seq
   *  is a total order per runtime. */
  const fanOut = (rt: Runtime, change: StoreChange<T>): void => {
    rt.emissionSeq += 1
    for (const l of rt.listeners) {
      try {
        l(change as StoreChange<unknown>)
      } catch (e) {
        logForDebugging(`[${cfg.name}] subscriber threw (ignored): ${e}`)
      }
    }
  }

  const scheduleEmit = (path: string, rt: Runtime): void => {
    if (rt.listeners.size === 0) return
    if (rt.debounceTimer) clearTimeout(rt.debounceTimer)
    rt.debounceTimer = setTimeout(() => {
      rt.debounceTimer = null
      void emitIfChanged(path, rt)
    }, cfg.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS)
    rt.debounceTimer.unref?.()
  }

  const startWatcher = (path: string, rt: Runtime): void => {
    if (rt.watcher || rt.watcherStarting || rt.pollTimer) return
    rt.watcherStarting = (async () => {
      try {
        // chokidar v4+ CANNOT watch a not-yet-existent path (v3's glob engine
        // could): it attaches to nothing and never fires, so a subscription
        // armed before the store's first write would go permanently deaf to
        // cross-process changes — a board froze on exactly this (the
        // reader subscribed at mount; the daemon created the file ~1s later).
        // Poll at the documented-fallback cadence until the file first exists,
        // then re-enter to attach the real watcher.
        try {
          await stat(path)
        } catch (e) {
          if (getErrnoCode(e) === 'ENOENT') {
            startPollUntilExists(path, rt)
            return
          }
          // Other stat failures fall through — chokidar's own error handler
          // decides (it degrades to the permanent polling fallback).
        }
        const { default: chokidar } = await import('chokidar')
        if (rt.listeners.size === 0) return // all unsubscribed while importing
        const watcher = chokidar.watch(resolveWatchRoot(path), {
          persistent: false,
          ignoreInitial: true,
          // Atomic publish = rename-in; chokidar's atomic handling coalesces the
          // unlink/add pair editors and rename-writers produce.
          atomic: true,
          ignorePermissionErrors: true,
        })
        watcher.on('add', () => scheduleEmit(path, rt))
        watcher.on('change', () => scheduleEmit(path, rt))
        watcher.on('unlink', () => {
          scheduleEmit(path, rt)
          // chokidar v4 cannot watch a non-existent path (see the attach
          // comment above) — and an unlinked path IS one: after this event
          // the watch is permanently deaf, so a later recreate (atomic
          // writer from another process) would never emit. Re-arm through
          // the same poll-until-exists ladder the initial attach uses.
          // Measured: prove-filestore-ordering sat 3s+ deaf without it.
          void watcher.close().catch(() => {})
          if (rt.watcher === watcher) rt.watcher = null
          if (rt.pollFloorTimer) {
            clearInterval(rt.pollFloorTimer)
            rt.pollFloorTimer = null
          }
          if (rt.listeners.size > 0) startPollUntilExists(path, rt)
        })
        watcher.on('error', (e: unknown) => {
          logForDebugging(`[${cfg.name}] watcher error, falling back to polling: ${e}`)
          void watcher.close().catch(() => {})
          if (rt.watcher === watcher) rt.watcher = null
          startPollFallback(path, rt)
        })
        rt.watcher = watcher
        // Belt: if the last listener unsubscribed anywhere in this async
        // start (stopWatching saw watcher=null then and had nothing to
        // close), close the just-attached watcher instead of leaking it
        // live with zero listeners.
        if (rt.listeners.size === 0) {
          stopWatching(path, rt)
          return
        }
        // Catch-up emit: a write can land in the attach window (between the
        // stat/import above and the OS watch going live) and would otherwise be
        // missed FOREVER (no later event re-fires for it). Content-dedup makes
        // this a no-op when nothing was missed. Measured: the proof's
        // write-right-after-poll-upgrade case missed without it.
        scheduleEmit(path, rt)
        // Opt-in steady floor alongside the healthy watcher: a silently-missed
        // cross-process event (measured — see pollFloorMs) costs at most one
        // floor interval instead of stranding until the next unrelated write.
        startPollFloor(path, rt)
      } catch (e) {
        // DOCUMENTED FALLBACK: no watch engine ⇒ poll.
        logForDebugging(
          `[${cfg.name}] watch engine unavailable (${e}) — polling fallback at ${cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS}ms`,
        )
        startPollFallback(path, rt)
      } finally {
        rt.watcherStarting = null
      }
    })()
  }

  const startPollFallback = (path: string, rt: Runtime): void => {
    if (rt.pollTimer || rt.listeners.size === 0) return
    // A full poll fallback SUPERSEDES the opt-in floor — never double-poll.
    if (rt.pollFloorTimer) {
      clearInterval(rt.pollFloorTimer)
      rt.pollFloorTimer = null
    }
    rt.pollTimer = setInterval(
      () => void emitIfChanged(path, rt),
      cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS,
    )
    rt.pollTimer.unref?.()
  }

  /** The opt-in steady poll ALONGSIDE a healthy watcher (cfg.pollFloorMs) —
   *  emitIfChanged is content-deduped, so a tick is a no-op read unless the
   *  bytes actually changed. No-op when the store doesn't opt in. */
  const startPollFloor = (path: string, rt: Runtime): void => {
    // LINUX DEFAULT FLOOR (mercury-feel — release run
    // 29173305462): an inotify watch on a bare FILE goes permanently deaf
    // after publishAtomic's rename-over replaces the inode (no unlink event
    // fires for a rename-onto, so the re-arm ladder never engages) — both
    // CI watcher proofs sat at seen=0 through 15s of retried cross-process
    // writes while the poll-ladder case delivered. macOS FSEvents is
    // path-based and unaffected. On Linux every subscribed store gets the
    // steady floor at the documented fallback cadence unless the store set
    // its own; content-dedup keeps healthy-watcher ticks free.
    // the floor is NOT Linux-only any more. The rationale above
    // explains why Linux NEEDS it (a rename-over leaves an inode watch
    // permanently deaf) and concluded that "macOS FSEvents is path-based and
    // unaffected". Path-based does not mean lossless: FSEvents coalesces and
    // drops under system load, and with the floor at 0 there is NO backstop
    // on macOS — a subscriber simply never learns the file went away.
    //
    // Measured, not theorised: prove-filestore-ordering delivers the
    // post-unlink empty() in ~150ms solo, and did not deliver it within
    // FIFTEEN SECONDS under a 129-suite pool. Raising that budget (which I
    // did first) only hid it. Two stores had already reached for
    // `pollFloorMs: 2000` by hand for exactly this class, on every
    // platform (routerRunStore still does) — this makes the default agree.
    //
    // Cost is bounded by content-dedup: a healthy watcher makes each tick a
    // stat+read that emits nothing, and the floor only runs while the store
    // has listeners (the idle law is untouched).
    const floorMs = cfg.pollFloorMs ?? cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS
    if (!floorMs || floorMs <= 0) return
    if (rt.pollFloorTimer || rt.listeners.size === 0) return
    rt.pollFloorTimer = setInterval(
      () => void emitIfChanged(path, rt),
      floorMs,
    )
    rt.pollFloorTimer.unref?.()
  }

  /** Poll until `path` first exists, then upgrade to the real watcher (a
   *  watcher cannot attach to a nonexistent path — see startWatcher). The
   *  emitIfChanged inside each tick also DELIVERS the first content, so the
   *  upgrade never costs the subscriber an event. */
  const startPollUntilExists = (path: string, rt: Runtime): void => {
    if (rt.pollTimer || rt.listeners.size === 0) return
    rt.pollTimer = setInterval(() => {
      void (async () => {
        await emitIfChanged(path, rt)
        try {
          await stat(path)
        } catch {
          return // still absent — keep polling
        }
        // Exists now: hand off to chokidar (clear our timer FIRST so
        // startWatcher's re-entrancy guard lets the attach through).
        if (rt.pollTimer) {
          clearInterval(rt.pollTimer)
          rt.pollTimer = null
        }
        startWatcher(path, rt)
      })()
    }, cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS)
    rt.pollTimer.unref?.()
  }

  const stopWatching = (path: string, rt: Runtime): void => {
    if (rt.watcher) {
      void rt.watcher.close().catch(() => {})
      rt.watcher = null
    }
    if (rt.pollTimer) {
      clearInterval(rt.pollTimer)
      rt.pollTimer = null
    }
    if (rt.pollFloorTimer) {
      clearInterval(rt.pollFloorTimer)
      rt.pollFloorTimer = null
    }
    if (rt.debounceTimer) {
      clearTimeout(rt.debounceTimer)
      rt.debounceTimer = null
    }
    // Full watermark reset, not just the byte latch: a re-subscribe
    // baselines FRESH (its immediate read seeds lastSeenRevision), so a
    // stale revision/opId watermark from the previous subscription must
    // not leak into the next one's skip accounting or echo dedup.
    rt.lastEmittedRaw = null
    rt.lastSeenRevision = null
    rt.lastEmittedOpId = null
    rt.emitDirty = false
  }

  const ensureExists = async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    try {
      // 'wx': first creator wins; concurrent creators no-op (proper-lockfile
      // requires the lock target to exist).
      await writeFile(path, encodeValue(cfg.empty()), { flag: 'wx' })
    } catch (e) {
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  }

  const makeHandle = (path: string): StoreHandle<T> => {
    const rt = getRuntime(path)

    const publish = async (
      value: T,
      prevRevision: StoreRevision | null,
      cause: StoreChangeCause = 'local-commit',
    ): Promise<void> => {
      const encoded = (cfg.encode ?? (v => v as unknown))(value)
      const isObjectShaped =
        encoded !== null && typeof encoded === 'object' && !Array.isArray(encoded)
      // A successful mutation advances the monotonic revision EXACTLY once —
      // minted under the lock and committed in the SAME atomic rename as the
      // value (object stores). Bare arrays carry no in-band stamp: their
      // revision derives from the declared revisionOf, or stays null.
      const revision = isObjectShaped
        ? nextRevision(prevRevision, payloadDigest(jsonStringify(encoded)))
        : null
      const stampedPayload = isObjectShaped
        ? {
            ...(encoded as Record<string, unknown>),
            [VERSION_KEY]: cfg.schemaVersion,
            ...(revision ? { [REVISION_KEY]: revision } : {}),
          }
        : encoded
      const raw = jsonStringify(stampedPayload, null, 2) + '\n'
      await publishAtomic(path, raw)
      // IMMEDIATE in-process fan-out of the value we just committed — the
      // already-decoded T, one microtask after the rename resolves; never
      // the watcher debounce (which cost 25ms + a disk re-read and made
      // "zero-latency" a lie), and never re-reading the file (a
      // concurrent writer's bytes are THEIR emission, not this one's).
      // The raw latch updates NOW so the watcher's echo of our own write
      // dedupes (by bytes AND, for stamped stores, by operation id); a
      // cross-process write that lands after ours produces different bytes
      // and still emits through emitIfChanged.
      const emitted = revision ?? revisionFor(null, value)
      // The epoch advances in the SAME synchronous block as the latch: any
      // emitIfChanged read already in flight captured the previous epoch and
      // will discard itself at the fence instead of fanning out stale bytes.
      rt.publishEpoch += 1
      rt.lastEmittedRaw = raw
      rt.lastEmittedOpId = revision?.operationId ?? null
      if (emitted) {
        rt.lastSeenRevision = Math.max(rt.lastSeenRevision ?? 0, emitted.revision)
      }
      if (rt.listeners.size > 0) {
        queueMicrotask(() =>
          fanOut(rt, { value, revision: emitted, cause, skippedRevisions: 0 }),
        )
      }
    }

    // The batching discipline itself lives in ONE owner (substrate/groupCommit):
    // ordering, per-caller isolation, durability-before-settle and batch bounding
    // are guaranteed there, so this store only supplies its own IO — how to lock,
    // how to read (including the FC5 recovery path), and how to publish.
    const lane = groupCommitLane<T, { prevRevision: StoreRevision | null; cause: StoreChangeCause }>({
      acquire: async () => {
        await ensureExists(path)
        compromisedLocks.delete(path)
        return lockfile.lock(path, storeLockOptions(path))
      },
      read: async () => {
        const { result: rr, raw } = await readResultAt(path, rt)
        if (rr.state === 'recoverable') {
          // The FC5 guard. 'throw'-policy stores abort unchanged (their
          // declared behavior — the mutation never proceeds).
          if (cfg.onReadFailure === 'throw') throw new Error(rr.reason)
          // Declared fail-open: PRESERVE the damaged bytes (bounded quarantine
          // + recovery ledger) BEFORE anything can republish over the only
          // damaged copy, then resume from the runtime's last known committed
          // value when one exists.
          const resumedFrom = rr.lastGood !== undefined ? 'last-good' : 'empty'
          await quarantineDamagedStore({
            store: cfg.name,
            path,
            rawBytes: raw,
            reason: rr.reason,
            resumedFrom,
          })
          logForDebugging(
            `[${cfg.name}] recoverable store quarantined; mutation resumes from ${resumedFrom}`,
            { level: 'warn' },
          )
          return {
            value: rr.lastGood ?? cfg.empty(),
            context: {
              // Revision continuity: resume from the runtime's last observed
              // revision so the counter stays monotonic across the recovery.
              prevRevision:
                rt.lastSeenRevision !== null
                  ? {
                      revision: rt.lastSeenRevision,
                      writerId: 'recovery',
                      operationId: '',
                      committedAt: '',
                      digest: '',
                    }
                  : null,
              cause: 'recovery' as StoreChangeCause,
            },
          }
        }
        return {
          value: rr.value,
          context: {
            prevRevision: rr.state === 'ready' ? rr.revision : null,
            cause: 'local-commit' as StoreChangeCause,
          },
        }
      },
      // Ownership is re-checked at the COMMIT boundary, not merely at
      // acquisition: the mutation callbacks ran in between, and a lock lost
      // during them would otherwise publish over whoever holds it now.
      beforePublish: () => assertStillHeld(path),
      publish: (next, ctx) => publish(next, ctx.prevRevision, ctx.cause),
    })

    const locked = <R>(fn: (current: T) => Promise<{ next: T; result: R }>): Promise<R> =>
      lane.submit(fn)

    const subscribeChanges = (
      listener: (change: StoreChange<T>) => void,
      opts?: { immediate?: boolean },
    ): (() => void) => {
      const l = listener as (change: StoreChange<unknown>) => void
      rt.listeners.add(l)
      startWatcher(path, rt)
      if (opts?.immediate !== false) {
        // Guard the async initial read against the never-old-after-new
        // invariant: if ANY emission reached this listener while the read
        // was in flight, the read's (older-or-equal) value is stale —
        // discard it rather than deliver old state last.
        const seqAtSubscribe = rt.emissionSeq
        void readResultAt(path, rt)
          .then(({ result: rr }) => {
            if (!rt.listeners.has(l)) return
            if (rt.emissionSeq !== seqAtSubscribe) return
            if (rr.state === 'recoverable') return // never fabricate a value
            const revision = rr.state === 'ready' ? rr.revision : null
            // First observation baselines the runtime's revision watermark
            // so later skips are provable from the subscriber's own start.
            if (revision && rt.lastSeenRevision === null) {
              rt.lastSeenRevision = revision.revision
            }
            listener({
              value: rr.value,
              revision,
              cause: 'catch-up',
              skippedRevisions: 0,
            })
          })
          .catch(e =>
            logForDebugging(`[${cfg.name}] immediate subscribe read failed: ${e}`),
          )
      }
      return () => {
        rt.listeners.delete(l)
        if (rt.listeners.size === 0) stopWatching(path, rt)
      }
    }

    return {
      path,
      read: () => readAt(path),
      readResult: async () => (await readResultAt(path, rt)).result,
      update: fn => locked(async cur => await fn(cur)),
      mutate: fn =>
        locked(async cur => ({ next: await fn(cur), result: undefined })),
      write: value => locked(async () => ({ next: value, result: undefined })),
      // The ergonomic legacy shape — an adapter over subscribeChanges.
      subscribe: (listener, opts) =>
        subscribeChanges(chg => listener(chg.value), opts),
      subscribeChanges,
      _statsForProofs: () => ({
        listeners: rt.listeners.size,
        watcher: rt.watcher !== null,
        watcherStarting: rt.watcherStarting !== null,
        pollTimer: rt.pollTimer !== null,
        pollFloorTimer: rt.pollFloorTimer !== null,
        debounceTimer: rt.debounceTimer !== null,
        emissionSeq: rt.emissionSeq,
        publishEpoch: rt.publishEpoch,
        lastSeenRevision: rt.lastSeenRevision,
        lastEmittedOpId: rt.lastEmittedOpId,
      }),
    }
  }

  return (...args: A): StoreHandle<T> => {
    const path = cfg.path(...args)
    let handle = handles.get(path)
    if (!handle) {
      handle = makeHandle(path)
      handles.set(path, handle)
    }
    return handle
  }
}
