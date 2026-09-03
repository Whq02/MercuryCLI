/**
 * pidLock — the ONE pid-liveness mutex (HANDOFF-REACTIVE-SUBSTRATE Phase 1).
 *
 * Replaces the three copy-pasted O_EXCL + pid-probe mutexes (`cronTasksLock.ts`,
 * `controlSocket.ts` supervisor lock, `computerUseLock.ts`) with one helper whose
 * behavioral knobs are DECLARED, not accidents of each copy:
 *
 *   - Atomic WHOLE-RECORD claim: the payload is staged to a temp and hard-linked
 *     in (link(2) fails EEXIST when held), so the lock file is never visible
 *     empty or partial — two racing acquirers can't both win, and a reader can
 *     never mistake a mid-write claim for an unparseable (reclaimable) record.
 *   - Holder record: { owner, pid, acquiredAt, procStart } — `procStart` is the
 *     /proc start-time token (linux; undefined elsewhere) so a REUSED pid is
 *     detected instead of treated as the live owner (the cronScheduler isPidGone
 *     pattern, now shared by all consumers).
 *   - Same-owner re-acquire ADOPTS: after --resume the owner identity persists but
 *     the pid changes; the lock is re-stamped in place (the cronTasksLock behavior)
 *     via an atomic whole-record replace.
 *   - Stale holder (dead pid / reused pid / unparseable record) is reclaimed by
 *     confirmed CLOBBER-CLAIM: the judgment is re-read after REAP_CONFIRM_MS
 *     (byte-identical or abort), the reclaimer's own claim is renamed OVER the
 *     dead record (never a claimable vacancy), and a read-back picks the single
 *     winner among racing reclaimers. A same-microsecond claim landing between
 *     a reclaimer's confirmation read and its rename remains the one
 *     irreducible fs-primitive window — every broader race is closed.
 *   - `liveness` POLARITY is declared per lock: 'assume-alive' refuses to steal on
 *     any ambiguous probe (safety gates — the daemon supervisor lock, where a false
 *     steal orphans a live daemon); 'assume-dead' treats an ambiguous probe as gone
 *     (single-user convenience locks — cron scheduler, computer-use — where a stuck
 *     lock is worse than a rare double-acquire).
 *
 * Unexpected filesystem errors REFUSE (return blocked) rather than throw — a lock
 * helper must never crash its caller; every consumer treats "can't acquire" as
 * "stay passive".
 */

import { randomUUID } from 'crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  isTransientWin32FsCode,
  renameRetryDelayMs,
  renameWithWin32Retry,
} from './durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import { procStartToken, currentProcStart } from '../utils/genericProcessUtils.js'
import { getProcessStartTokenAsync, getProcessStartTokenCachedOrRefresh } from '../daemon/ownerWatch.js'
import { safeParseJSON } from '../utils/json.js'
import { sleep } from '../utils/sleep.js'
import { jsonStringify } from '../utils/slowOperations.js'

export type LivenessPolarity = 'assume-alive' | 'assume-dead'

/** The claimer's own start token for the record — linux /proc first (free),
 *  else the cross-platform owner's async probe (one spawn per CLAIM, never
 *  per probe); a gone/unknown answer records no field, which keeps today's
 *  pid-only behavior for that record. */
async function currentProcStartAnyPlatform(): Promise<{ procStartField: { procStart: string } | Record<string, never> }> {
  const local = currentProcStart()
  if (local) return { procStartField: { procStart: local } }
  const probed = await getProcessStartTokenAsync(process.pid)
  return { procStartField: probed ? { procStart: probed } : {} }
}

/** Pre-fetch a holder's live token for the identity compare — only when the
 *  record carries one (a pid-only record never pays a probe). */
async function liveTokenFor(holder: PidLockHolder | null): Promise<string | null | undefined> {
  if (!holder?.procStart) return undefined
  // Read the live token in the RECORD's own vocabulary. A claim on linux
  // writes the /proc start time (clock ticks, digits); `ps -o lstart=` is
  // another vocabulary that never byte-equals it, so comparing across the
  // two judged a LIVE holder dead on linux — its own record read as
  // reclaimable, a contender co-admitted (the null-probe class).
  if (/^\d+$/.test(holder.procStart)) {
    const local = procStartToken(holder.pid)
    if (local !== undefined) return local
    // /proc holds no stat for the pid: gone (the async owner says '' too)
    // or unreadable — a ps token cannot be compared, so it is unknowable.
    const probed = await getProcessStartTokenAsync(holder.pid)
    return probed === '' ? '' : null
  }
  return getProcessStartTokenAsync(holder.pid)
}

export interface PidLockHolder {
  owner: string
  pid: number
  acquiredAt: number
  procStart?: string
}

export type PidLockAcquire =
  | { held: true; fresh: boolean }
  | { held: false; by?: PidLockHolder }

/**
 * Parse a holder record; null when unparseable (treated as stale).
 * MIGRATION ALIASES: the three pre-kernel copies each had their own field names
 * — cronTasksLock/computerUseLock wrote `sessionId`, the supervisor lock wrote
 * `id` + `startedAt`. Accept those as `owner`/`acquiredAt` so a lock written by
 * a still-running OLD build is honored (never treated as stale and stolen).
 * Writers also mirror the legacy field via `extra` for the reverse direction.
 * Remove once the fleet is past the migration window.
 */
function parseHolder(raw: string): PidLockHolder | null {
  const parsed = safeParseJSON(raw, false) as
    | (Partial<PidLockHolder> & { sessionId?: string; id?: string; startedAt?: number })
    | null
  if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number') {
    return null
  }
  const owner = parsed.owner ?? parsed.sessionId ?? parsed.id
  if (typeof owner !== 'string' || owner.length === 0) return null
  const acquiredAt = parsed.acquiredAt ?? parsed.startedAt
  return {
    owner,
    pid: parsed.pid,
    acquiredAt: typeof acquiredAt === 'number' ? acquiredAt : 0,
    ...(typeof parsed.procStart === 'string'
      ? { procStart: parsed.procStart }
      : {}),
  }
}

async function readHolder(path: string): Promise<PidLockHolder | null> {
  try {
    return parseHolder(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Raw record bytes, or null when unreadable — the reap confirmation compares
 *  bytes, not parses, so ANY change (even to an equally-dead record) aborts. */
async function readRawRecord(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** How long a dead-looking record must stay BYTE-IDENTICAL before a reclaim
 *  acts on it. A judgment made from one read can be stale by the time the
 *  removal lands (a sibling reclaimed and re-claimed in between); the
 *  confirmation delay re-reads and proceeds only when nothing moved. */
const REAP_CONFIRM_MS = 150

/**
 * Is the recorded holder still the LIVE owner of its pid?
 *   - signal-0 ESRCH ⇒ dead.
 *   - signal-0 other error (EPERM…) ⇒ ambiguous ⇒ per polarity.
 *   - pid alive but the recorded procStart token differs from the CURRENT token
 *     (both present) ⇒ the pid was REUSED by a different process ⇒ dead.
 *   - recorded-but-unreadable current token ⇒ can't prove reuse ⇒ alive.
 */
export function holderAlive(
  holder: PidLockHolder,
  polarity: LivenessPolarity,
  /** The holder pid's LIVE start token, pre-fetched by an async caller
   *  (null = unknowable, '' = gone); undefined ⇒ the sync fallback below. */
  liveToken?: string | null,
): boolean {
  // pid ≤ 1 is never a legitimate holder (0 = our own process group, 1 = init),
  // so probing would lie (kill(0,0) always succeeds; kill(1,0) EPERMs). Resolve
  // by declared polarity: a safety gate refuses ('assume-alive'), a convenience
  // lock reclaims ('assume-dead' — the old isProcessRunning behavior).
  if (holder.pid <= 1) return polarity === 'assume-alive'
  try {
    process.kill(holder.pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false
    return polarity === 'assume-alive'
  }
  if (holder.procStart) {
    // THE REUSE GUARD ON EVERY PLATFORM (TASK-017 S2,
    // pidlock-reuse-guard-inert-on-win32 + win32-supervisor-lock-no-reuse-
    // token): the linux /proc token was the only reader, so a recycled pid
    // on win32 (a hard-killed holder, a closed WT tab, the exit abort) read
    // LIVE forever — the scheduler seat never fired again and the daemon
    // seat refused every start. Async callers pre-fetch the live token
    // through the one cross-platform owner (ownerWatch: ps lstart / win32
    // CIM CreationDate) and pass it here; the sync fallback reads linux
    // /proc, else the cached-or-refresh form that NEVER spawns on the loop.
    // Vocabulary: '' = the pid is GONE, a token = compare, null/undefined =
    // unknowable ⇒ alive (never a death verdict from a probe glitch).
    const current =
      liveToken !== undefined ? liveToken : (procStartToken(holder.pid) ?? getProcessStartTokenCachedOrRefresh(holder.pid))
    if (current === '') return false
    if (current !== null && current !== undefined && current !== holder.procStart) return false
  }
  return true
}

/**
 * Atomically claim `path` with the FULL record already in place: write the
 * payload to a sibling temp, then hard-link it in — link(2) fails EEXIST when
 * the path exists, and the winner's record is complete from the first instant
 * it is visible. The old `writeFile('wx')` claimed the path at open(2) and
 * wrote the bytes AFTER it, so a contender reading inside that window saw an
 * EMPTY record, judged it unparseable, and reclaimed a LIVE holder's lock —
 * the very lost-update this mutex exists to prevent (a high-contention caller
 * exposes it; the low-contention consumers never flush it out). Filesystems without hard links fall back
 * to the legacy exclusive create (the narrow window returns there; broken
 * claims do not).
 */
async function claimLockAtomically(
  path: string,
  payload: string,
): Promise<'won' | 'held' | 'noparent' | 'refused'> {
  const temp = `${path}.claim-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    await writeFile(temp, payload, { mode: 0o600 })
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return 'noparent'
    logForDebugging(`[pidLock] claim temp write failed at ${path}: ${e}`)
    return 'refused'
  }
  try {
    await link(temp, path)
    return 'won'
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'EEXIST') return 'held'
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
      try {
        await writeFile(path, payload, { flag: 'wx', mode: 0o600 })
        return 'won'
      } catch (wxErr) {
        if (getErrnoCode(wxErr) === 'EEXIST') return 'held'
        logForDebugging(`[pidLock] acquire failed at ${path}: ${wxErr}`)
        return 'refused'
      }
    }
    logForDebugging(`[pidLock] claim link failed at ${path}: ${e}`)
    return 'refused'
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/**
 * Try to acquire the lock at `path` for `owner`. Never throws.
 * Returns `{held:true, fresh}` (fresh=false ⇒ adopted our own prior record) or
 * `{held:false, by}` when a live holder owns it (`by` undefined ⇒ refused on an
 * unexpected error).
 */
export async function acquirePidLock(
  path: string,
  owner: string,
  opts: {
    liveness: LivenessPolarity
    /** Extra fields mirrored into the record — the legacy alias keys a
     *  still-running OLD build's reader requires (e.g. `sessionId`). */
    extra?: Record<string, unknown>
  },
): Promise<PidLockAcquire> {
  // An owner-less record is unreadable to every reader (parseHolder demands
  // a non-empty owner), so a claim with an empty identity plants a lock
  // nobody can parse — and a later acquire under the same empty identity
  // dereferenced that null record (the scheduler-probe TypeError,
  // every --resume boot that ran without a session id).
  if (typeof owner !== 'string' || owner.length === 0) {
    logForDebugging(`[pidLock] refused to claim ${path}: empty owner identity`)
    return { held: false }
  }
  const payload = jsonStringify({
    ...(opts.extra ?? {}),
    owner,
    pid: process.pid,
    acquiredAt: Date.now(),
    ...(await currentProcStartAnyPlatform()).procStartField,
  })

  for (let attempt = 0; attempt < 2; attempt++) {
    let claim = await claimLockAtomically(path, payload)
    if (claim === 'noparent') {
      // Parent dir missing — create and retry the atomic claim.
      try {
        await mkdir(dirname(path), { recursive: true })
      } catch (e) {
        logForDebugging(`[pidLock] acquire failed at ${path}: ${e}`)
        return { held: false }
      }
      claim = await claimLockAtomically(path, payload)
    }
    if (claim === 'won') return { held: true, fresh: true }
    if (claim !== 'held') return { held: false }

    const holder = await readHolder(path)
    // Ours (same owner identity, e.g. post---resume with a new pid): adopt by
    // re-stamping in place so other processes see a live pid. The re-stamp is
    // a whole-record atomic replace — a reader must never see a partial one.
    if (holder !== null && holder.owner === owner) {
      if (holder.pid !== process.pid) {
        const temp = `${path}.restamp-${process.pid}-${randomUUID().slice(0, 8)}`
        try {
          await writeFile(temp, payload, { mode: 0o600 })
          await renameWithWin32Retry(temp, path)
        } catch (restampErr) {
          await unlink(temp).catch(() => {})
          logForDebugging(`[pidLock] adopt re-stamp failed: ${restampErr}`)
          return { held: false, by: holder }
        }
      }
      return { held: true, fresh: false }
    }
    // A LIVE other holder: blocked (identity-checked where the record
    // carries a token).
    if (holder && holderAlive(holder, opts.liveness, await liveTokenFor(holder))) {
      return { held: false, by: holder }
    }
    // Stale (dead / reused pid) or unparseable: reclaim by CLOBBER-CLAIM.
    // A one-read judgment can be stale by the time the removal lands (a
    // sibling already reclaimed and re-claimed in the gap; a bare unlink
    // then deleted the sibling's FRESH claim and re-admitted two holders):
    //   1. confirm — the record must stay byte-identical across
    //      REAP_CONFIRM_MS (any movement means someone acted; start over);
    //   2. replace — rename OUR pre-staged claim OVER the dead record
    //      (atomic: the path never passes through a claimable vacancy);
    //   3. verify — only OUR bytes at the path afterwards means we won
    //      (racing reclaimers clobber each other; every loser sees the
    //      winner's record here and backs off).
    const judged = await readRawRecord(path)
    if (judged === null) continue // vanished — the next claim attempt decides
    await sleep(REAP_CONFIRM_MS)
    if ((await readRawRecord(path)) !== judged) continue
    const temp = `${path}.claim-${process.pid}-${randomUUID().slice(0, 8)}`
    try {
      await writeFile(temp, payload, { mode: 0o600 })
      await renameWithWin32Retry(temp, path)
    } catch (e) {
      await unlink(temp).catch(() => {})
      logForDebugging(`[pidLock] stale-record reclaim failed at ${path}: ${e}`)
      return { held: false }
    }
    if ((await readRawRecord(path)) === payload) return { held: true, fresh: true }
  }
  return { held: false }
}

/** A live holder blocked the whole retry budget — never stolen from. */
export class PidLockBusyError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `pid lock busy: ${lockPath}${holderPid !== null ? ` (live holder pid ${holderPid} — never stolen from)` : ''}`,
    )
    this.name = 'PidLockBusyError'
  }
}

/**
 * Blocking acquisition with jittered exponential backoff (the
 * shared retry idiom for callers moving off mtime-lease locks, owned HERE so
 * new consumers never copy it). A LIVE holder is never stolen from — exhaustion throws the typed busy
 * error naming the holder; a dead holder reclaims via acquire's confirmed
 * clobber-claim.
 */
export async function acquirePidLockWithRetry(
  path: string,
  owner: string,
  opts: {
    liveness: LivenessPolarity
    retries?: number
    minTimeoutMs?: number
    maxTimeoutMs?: number
    extra?: Record<string, unknown>
  },
): Promise<{ release: () => Promise<PidLockReleaseReceipt> }> {
  const retries = opts.retries ?? 30
  const minMs = opts.minTimeoutMs ?? 5
  const maxMs = opts.maxTimeoutMs ?? 100
  let lastHolderPid: number | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const got = await acquirePidLock(path, owner, {
      liveness: opts.liveness,
      ...(opts.extra ? { extra: opts.extra } : {}),
    })
    if (got.held) {
      return { release: () => releasePidLock(path, owner) }
    }
    if (got.by) lastHolderPid = got.by.pid
    if (attempt < retries) {
      const backoff = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 10))
      await sleep(backoff * (0.5 + Math.random() * 0.5))
    }
  }
  throw new PidLockBusyError(path, lastHolderPid)
}

// ── truthful release ─────────────────────
// The old release swallowed its unlink error and returned true whenever the
// owner matched — on win32 a transient EPERM/EBUSY/EACCES (AV/indexer/open
// handle) left the lock PRESENT while every caller recorded success (the
// field's 8/11 residual head locks). Release now settles to a typed receipt
// and NEVER reports removal without verified absence of OUR record.

export interface PidLockReleaseReceipt {
  /**
   * removed — our record is confirmed gone (or a successor claimed the
   *            vacancy after our removal landed);
   * absent — nothing at the path to release;
   * not-held — a record exists but is not ours (successor/foreign — retained);
   * deferred — the win32 transient class outlived the bounded ladder; the
   *            lock may remain and reconciliation owns the remainder;
   * failed — a structural (non-transient) failure with a named errno.
   */
  outcome: 'removed' | 'absent' | 'not-held' | 'deferred' | 'failed'
  /** Unlink attempts actually made (0 when nothing was ours to unlink). */
  attempts: number
  /** errno of the terminal failure (deferred/failed). */
  fsCode?: string
}

/** Bounded release-health receipt (the durablePublish health shape): how often
 *  a release could NOT truthfully remove its lock, and how often the bounded
 *  ladder saved one. Surfaced through /doctor; never consulted by release. */
export interface PidLockReleaseHealth {
  notRemoved: {
    count: number
    last: { path: string; outcome: 'deferred' | 'failed'; fsCode?: string; attempts: number; atMs: number } | null
  }
  retriedSuccesses: {
    count: number
    last: { path: string; attempts: number; atMs: number } | null
  }
}

const releaseHealth: PidLockReleaseHealth = {
  notRemoved: { count: 0, last: null },
  retriedSuccesses: { count: 0, last: null },
}

/** A copy of the bounded release-health receipt. */
export function pidLockReleaseHealth(): PidLockReleaseHealth {
  return {
    notRemoved: {
      count: releaseHealth.notRemoved.count,
      last: releaseHealth.notRemoved.last ? { ...releaseHealth.notRemoved.last } : null,
    },
    retriedSuccesses: {
      count: releaseHealth.retriedSuccesses.count,
      last: releaseHealth.retriedSuccesses.last ? { ...releaseHealth.retriedSuccesses.last } : null,
    },
  }
}

/** Proof seam (never product logic): reset the release-health receipt. */
export function _resetPidLockReleaseHealthForProofs(): void {
  releaseHealth.notRemoved = { count: 0, last: null }
  releaseHealth.retriedSuccesses = { count: 0, last: null }
}

/**
 * The DR-08 caller idiom: consume a release receipt instead of discarding it.
 * A non-removed outcome is recorded honestly (debug log; the health receipt
 * already counted it) — reconciliation owns any remainder. Returns the
 * receipt for chaining.
 */
export function noteLockRelease(label: string, receipt: PidLockReleaseReceipt): PidLockReleaseReceipt {
  if (receipt.outcome === 'deferred' || receipt.outcome === 'failed') {
    logForDebugging(
      `[pidLock] ${label}: release ${receipt.outcome} (${receipt.fsCode ?? 'unknown'}, ${receipt.attempts} attempts) — reconciliation owns the remainder`,
    )
  }
  return receipt
}

type RawRead =
  | { kind: 'ok'; raw: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; code?: string }

async function readRawClassified(path: string): Promise<RawRead> {
  try {
    return { kind: 'ok', raw: await readFile(path, 'utf8') }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', ...(code ? { code } : {}) }
  }
}

/**
 * Release the lock at `path` iff `owner` still holds it — never unlink a
 * successor's lock after losing a reclaim race. Owner-identity match (not pid):
 * a resumed session (same identity, new pid) must be able to release its own
 * pre-resume lock.
 *
 * One logical settlement: read → owner check → bounded unlink → verify. The
 * transient win32 unlink class rides the SHARED bounded ladder
 * (renameRetryDelayMs — one policy, one place); a successful unlink is only
 * `removed` when OUR record is verifiably gone (win32 delete-pending keeps the
 * name visible and re-enters the ladder). `seams` is the proof seam — never
 * pass it from product code.
 */
export async function releasePidLock(
  path: string,
  owner: string,
  seams?: {
    doUnlink?: (p: string) => Promise<void>
    readRaw?: (p: string) => Promise<RawRead>
    platform?: NodeJS.Platform
    sleepMs?: (ms: number) => Promise<void>
  },
): Promise<PidLockReleaseReceipt> {
  const doUnlink = seams?.doUnlink ?? ((p: string) => unlink(p))
  const readRaw = seams?.readRaw ?? readRawClassified
  const platform = seams?.platform ?? process.platform
  const sleepMs = seams?.sleepMs ?? sleep

  const settle = (receipt: PidLockReleaseReceipt): PidLockReleaseReceipt => {
    if (receipt.outcome === 'deferred' || receipt.outcome === 'failed') {
      releaseHealth.notRemoved.count += 1
      releaseHealth.notRemoved.last = {
        path,
        outcome: receipt.outcome,
        ...(receipt.fsCode ? { fsCode: receipt.fsCode } : {}),
        attempts: receipt.attempts,
        atMs: Date.now(),
      }
    } else if (receipt.outcome === 'removed' && receipt.attempts > 1) {
      releaseHealth.retriedSuccesses.count += 1
      releaseHealth.retriedSuccesses.last = { path, attempts: receipt.attempts, atMs: Date.now() }
    }
    return receipt
  }

  const initial = await readRaw(path)
  if (initial.kind === 'missing') return settle({ outcome: 'absent', attempts: 0 })
  if (initial.kind === 'unreadable') {
    // Can't prove the record is ours — never unlink blind. Honest failure.
    return settle({ outcome: 'failed', attempts: 0, ...(initial.code ? { fsCode: initial.code } : {}) })
  }
  const holder = parseHolder(initial.raw)
  if (!holder || holder.owner !== owner) return settle({ outcome: 'not-held', attempts: 0 })

  for (let attempt = 1; ; attempt++) {
    let code: string | undefined
    try {
      await doUnlink(path)
    } catch (e) {
      code = getErrnoCode(e)
      // Vanished under us — a sibling resolved it; benign (the reader-side
      // claim-vanish law).
      if (code === 'ENOENT') return settle({ outcome: 'removed', attempts: attempt })
      if (code === undefined) code = 'EUNKNOWN'
    }
    if (code === undefined) {
      // Verify absence — DR-02: never report removed while OUR record remains.
      const after = await readRaw(path)
      if (after.kind === 'missing') return settle({ outcome: 'removed', attempts: attempt })
      if (after.kind === 'ok') {
        const afterHolder = parseHolder(after.raw)
        if (!afterHolder || afterHolder.owner !== owner) {
          // A successor claimed the vacancy after our removal landed — our
          // release settled; their lock is not ours to touch.
          return settle({ outcome: 'removed', attempts: attempt })
        }
      }
      // Our bytes (or an unreadable name) still present after a "successful"
      // unlink — the win32 delete-pending shape. Ride the transient ladder.
      code = 'EBUSY'
    }
    const delay = renameRetryDelayMs(code, attempt, platform)
    if (delay === null) {
      return settle({
        outcome: platform === 'win32' && isTransientWin32FsCode(code) ? 'deferred' : 'failed',
        attempts: attempt,
        fsCode: code,
      })
    }
    await sleepMs(delay)
  }
}

/**
 * The current LIVE holder at `path`, or null (absent / stale / unparseable).
 * `reclaimStale: true` additionally unlinks a stale record on sight so a dead
 * holder stops blocking pre-acquire checks (the computerUseLock check contract).
 */
export async function probePidLock(
  path: string,
  opts: { liveness: LivenessPolarity; reclaimStale?: boolean },
): Promise<PidLockHolder | null> {
  const holder = await readHolder(path)
  if (!holder) return null
  if (holderAlive(holder, opts.liveness, await liveTokenFor(holder))) return holder
  if (opts.reclaimStale) {
    // Confirmed take-aside (probe claims nothing, so a plain unlink would
    // race a claimer the same way acquire's old reclaim did): re-read after
    // the confirmation delay, TAKE the record with an atomic rename, then
    // judge what we actually hold — a live record taken on a stale judgment
    // is restored (link back; if a new claim landed meanwhile, the claim
    // stands and the taken copy is discarded).
    const judged = await readRawRecord(path)
    if (judged === null) return null
    await sleep(REAP_CONFIRM_MS)
    if ((await readRawRecord(path)) !== judged) return null
    const taken = `${path}.reap-${process.pid}-${randomUUID().slice(0, 8)}`
    try {
      await renameWithWin32Retry(path, taken)
    } catch {
      return null // a sibling moved first — nothing to reap
    }
    const takenHolder = parseHolder((await readRawRecord(taken)) ?? '')
    if (takenHolder && holderAlive(takenHolder, opts.liveness, await liveTokenFor(takenHolder))) {
      await link(taken, path).catch(() => {})
    }
    await unlink(taken).catch(() => {})
  }
  return null
}
