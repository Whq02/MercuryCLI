/**
 * durableAtomicPublish — the ONE durable publication primitive (the
 * crash-consistency program).
 *
 * Every production "write a complete file atomically" in Mercury routes
 * through here (async) or the sync twin (sync-contract callers only). The
 * contract, per phase:
 *
 *   create-temp  same-directory, collision-free temp name
 *                (`.<basename>.<pid>.<random8>.tmp`), created EXCLUSIVELY
 *                ('wx') — two writers can never share a temp file;
 *   write        the complete bytes;
 *   flush-file   fsync the temp file BEFORE rename, so the rename can never
 *                publish an empty/partial inode after a power loss;
 *   rename       atomic same-filesystem replace — readers see old-complete
 *                or new-complete, never torn. On win32 ONLY, EPERM/EBUSY/
 *                EACCES here are the transient AV/indexer/open-handle class
 * retried on the SAME prepared temp with
 *                the bounded 50/100/200ms backoff the private updater proved
 *                (installLayout imports the constants back from here — one
 *                law). The prepared temp stays valid between attempts, the
 *                committed destination is untouched throughout, structural
 *                errors (ENOENT/EROFS/EISDIR/ENOTDIR/EXDEV/…) throw
 *                immediately, and every non-win32 platform keeps
 *                single-attempt semantics byte-identical;
 *   flush-dir    fsync the parent directory AFTER rename on platforms that
 *                support it (POSIX; Windows cannot open directories for
 *                fsync — skipped there, documented), so the rename itself
 *                survives a crash;
 *   cleanup      a failed publication unlinks its own temp and PRESERVES the
 *                prior committed destination.
 *
 * Failures are typed ({@link DurablePublishError} with the failing phase,
 * the filesystem code, the attempts made, the elapsed wall time and the
 * temp-cleanup outcome) so diagnostics and the reliability fault suite can
 * address exact boundaries; success returns the same accounting as a
 * {@link DurablePublishReport}. `MERCURY_DURABLE_FSYNC=0` opts out of both
 * flush barriers (rename-only, the pre-slice behavior) for slow-disk
 * operators; `MERCURY_FAULT_INJECT` is the deterministic fault-point seam the
 * reliability suite drives (`<phase>[@<path-substring>]:<throw|kill|errno>`
 * with an optional `#N` first-N-hits bound — the win32 transient-lock shape;
 * zero-cost when unset).
 *
 * Orphan hygiene: the first publish into a directory (per process) sweeps
 * stale temps matching THIS primitive's naming pattern (never anything
 * else), bounded by age so a concurrent writer's live temp is never touched.
 * The recovery orchestrator runs the same sweep at boot.
 */
import { flagEnv } from './flagRegistry.js'

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export type PublishFailurePhase =
  | 'create-temp'
  | 'write'
  | 'flush-file'
  | 'rename'
  | 'flush-dir'
  | 'cleanup'

/** What became of the prepared temp file by the time the result was
 *  reported: `renamed` — it IS the destination now (success, and flush-dir
 *  failures after the visible rename); `removed` — a failed publication
 *  cleaned its own temp; `absent` — the temp was never created or was
 *  already gone; `remove-failed` — left behind (the age-gated orphan sweep
 *  collects it). */
export type TempCleanupOutcome = 'renamed' | 'removed' | 'absent' | 'remove-failed'

/** The success accounting a publication returns: how many
 *  rename attempts it took (1 = no contention), the wall time, and whether
 *  the win32 transient-lock retry arm fired. */
export interface DurablePublishReport {
  attempts: number
  elapsedMs: number
  retriedTransient: boolean
}

export interface DurablePublishFailureDetail {
  fsCode?: string
  attempts?: number
  elapsedMs?: number
  tempCleanup?: TempCleanupOutcome
}

export class DurablePublishError extends Error {
  /** errno of the underlying cause (`EPERM`, `EBUSY`, …) when one existed. */
  public readonly fsCode: string | undefined
  /** Attempts made at the failing phase (rename on win32: 1 + up to the
   *  bounded transient retries; every other phase/platform: 1). */
  public readonly attempts: number
  /** Wall time from publish start to the failure. */
  public readonly elapsedMs: number
  /** Temp-file cleanup outcome — see {@link TempCleanupOutcome}. */
  public readonly tempCleanup: TempCleanupOutcome
  constructor(
    public readonly phase: PublishFailurePhase,
    public readonly targetPath: string,
    cause: unknown,
    detail?: DurablePublishFailureDetail,
  ) {
    const fsCode = detail?.fsCode ?? errnoOf(cause)
    const attempts = detail?.attempts ?? 1
    const elapsedMs = detail?.elapsedMs ?? 0
    const tempCleanup = detail?.tempCleanup ?? 'absent'
    super(
      `durable publish failed at ${phase} for ${targetPath}: ${cause instanceof Error ? cause.message : String(cause)}` +
        (attempts > 1
          ? ` (${fsCode ?? 'transient'} persisted through ${attempts} attempts over ${elapsedMs}ms; temp ${tempCleanup})`
          : ''),
    )
    this.name = 'DurablePublishError'
    this.cause = cause
    this.fsCode = fsCode
    this.attempts = attempts
    this.elapsedMs = elapsedMs
    this.tempCleanup = tempCleanup
  }
}

/** errno of an unknown caught value, when it carries one. */
function errnoOf(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export interface DurablePublishOptions {
  /** File mode for the published file (e.g. 0o600 for credential-adjacent
   *  stores). Applied at temp creation so the mode is atomic with the bytes. */
  mode?: number
}

/** The temp naming pattern this primitive owns (and therefore may clean). */
const TEMP_PATTERN = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/

/** Only temps older than this are swept — a live writer's in-flight temp
 *  (milliseconds old) must never be deleted by a concurrent sweep. */
const ORPHAN_TEMP_MIN_AGE_MS = 10 * 60_000

/** Collision-free same-directory temp name for `path`. */
export function durableTempName(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  )
}

/** True iff `name` (a bare filename) matches the primitive's temp pattern. */
export function isDurableTempName(name: string): boolean {
  return TEMP_PATTERN.test(name)
}

// ── the win32 bounded-retry law ───────────────────────────
// EPERM/EBUSY/EACCES on a Windows rename are the transient AV/search-indexer/
// open-handle class: another program briefly holds the destination and the
// condition clears within milliseconds. The private updater proved the
// 50/100/200ms bounded backoff in the field (installLayout); this module now
// OWNS the law and the updater imports it back — one policy, one place.

/** The bounded backoff schedule: 1 initial attempt + one retry per entry. */
export const WIN32_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200]

/** The transient win32 rename class. Everything else is structural and must
 *  surface immediately (ENOENT/EROFS/EISDIR/ENOTDIR/EXDEV/ENOSPC/…). */
export function isTransientWin32FsCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * The PURE retry decision (table-provable on every platform): given the
 * errno of a failed rename attempt and the 1-based attempt number, the delay
 * before the next attempt — or null for "do not retry" (non-win32 platform,
 * structural error, or budget exhausted). Production callers pass no
 * platform; proofs pin it explicitly.
 */
export function renameRetryDelayMs(
  code: string | undefined,
  attempt: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform !== 'win32') return null
  if (!isTransientWin32FsCode(code)) return null
  if (attempt < 1 || attempt > WIN32_RENAME_RETRY_DELAYS_MS.length) return null
  return WIN32_RENAME_RETRY_DELAYS_MS[attempt - 1]!
}

const sleepAsync = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A rename EPERM/EACCES whose DESTINATION is a read-only file is structural,
 * not the transient AV/indexer class: the condition cannot clear within the
 * ladder, and startup fires many publishes — laddering would block ~350ms
 * per write, every write, every boot. Probed once, on the first failure;
 * any probe surprise falls back to the ladder (fail-open to the field-proven
 * behavior).
 */
function isReadOnlyDestination(to: string): boolean {
  try {
    const stats = statSync(to)
    return stats.isFile() && (stats.mode & 0o200) === 0
  } catch {
    return false
  }
}

// ── the beyond-budget observation ─────────────────────────────
// The 50/100/200ms ladder above IS the ratified product contract and stays
// untouched. This receipt gives the OBSERVATION teeth: how often the ladder
// was exhausted (a transient-class failure that outlived the whole budget)
// and how often it saved a publication (retried success) — bounded, fixed
// size, surfaced through the doctor certificate beside the other durability
// receipts. Never consulted by the publish path itself.

export interface DurablePublishHealth {
  /** Transient-class failures that exhausted the FULL ladder. */
  budgetExhausted: {
    count: number
    last: { path: string; fsCode?: string; attempts: number; elapsedMs: number; atMs: number } | null
  }
  /** Publications that succeeded only via the transient retry arm. */
  retriedSuccesses: {
    count: number
    last: { path: string; attempts: number; elapsedMs: number; atMs: number } | null
  }
}

const publishHealth: DurablePublishHealth = {
  budgetExhausted: { count: 0, last: null },
  retriedSuccesses: { count: 0, last: null },
}

/** The bounded publish-health receipt (a copy). */
export function durablePublishHealth(): DurablePublishHealth {
  return {
    budgetExhausted: {
      count: publishHealth.budgetExhausted.count,
      last: publishHealth.budgetExhausted.last ? { ...publishHealth.budgetExhausted.last } : null,
    },
    retriedSuccesses: {
      count: publishHealth.retriedSuccesses.count,
      last: publishHealth.retriedSuccesses.last ? { ...publishHealth.retriedSuccesses.last } : null,
    },
  }
}

function noteBudgetExhausted(path: string, fsCode: string | undefined, attempts: number, elapsedMs: number): void {
  // Only the transient class that actually rode the ladder counts — a
  // structural failure is not a budget outcome.
  if (!isTransientWin32FsCode(fsCode) || attempts <= 1) return
  publishHealth.budgetExhausted.count += 1
  publishHealth.budgetExhausted.last = { path, fsCode, attempts, elapsedMs, atMs: Date.now() }
}

function noteRetriedSuccess(path: string, attempts: number, elapsedMs: number): void {
  publishHealth.retriedSuccesses.count += 1
  publishHealth.retriedSuccesses.last = { path, attempts, elapsedMs, atMs: Date.now() }
}

/** Proof seam (never product logic): reset the receipt. */
export function _resetDurablePublishHealthForProofs(): void {
  publishHealth.budgetExhausted = { count: 0, last: null }
  publishHealth.retriedSuccesses = { count: 0, last: null }
}

/** Synchronous bounded sleep for the sync twin/process-exit paths. */
const sleepSyncMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * A plain rename under the win32 bounded-retry law — for genuine state moves
 * that CANNOT route through the full publication primitive (multi-file
 * change-set commit steps over pre-staged fsynced temps, directory
 * promotions, log rotation, adoption moves). Retries ONLY the transient
 * win32 class per {@link renameRetryDelayMs}; every other platform/error
 * throws the original error immediately. `doRename` lets shim-backed callers
 * (getFsImplementation) keep their seam. Each attempt consults the
 * `rename`-phase fault point first (path-filtered, zero-cost unset).
 */
export async function renameWithWin32Retry(
  from: string,
  to: string,
  doRename: (from: string, to: string) => Promise<unknown> = (f, t) => rename(f, t),
): Promise<{ attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      faultPoint('rename', to)
      await doRename(from, to)
      return { attempts: attempt }
    } catch (e) {
      const delay = renameRetryDelayMs(errnoOf(e), attempt)
      if (delay === null) throw e
      if (attempt === 1 && isReadOnlyDestination(to)) throw e
      await sleepAsync(delay)
    }
  }
}

/** Sync twin of {@link renameWithWin32Retry}. */
export function renameWithWin32RetrySync(
  from: string,
  to: string,
  doRename: (from: string, to: string) => void = renameSync,
): { attempts: number } {
  for (let attempt = 1; ; attempt++) {
    try {
      faultPoint('rename', to)
      doRename(from, to)
      return { attempts: attempt }
    } catch (e) {
      const delay = renameRetryDelayMs(errnoOf(e), attempt)
      if (delay === null) throw e
      if (attempt === 1 && isReadOnlyDestination(to)) throw e
      sleepSyncMs(delay)
    }
  }
}

export function fsyncEnabled(): boolean {
  return flagEnv('MERCURY_DURABLE_FSYNC') !== '0'
}

// Bounded-injection counters (`#N` specs): keyed on the WHOLE live spec +
// point so changing the injection between proof cases starts fresh
// (production runs never set the flag at all).
const faultHitCounts = new Map<string, number>()

/**
 * Deterministic fault-point seam (reliability suite only; zero-cost unset).
 * `MERCURY_FAULT_INJECT=<phase>[@<path-substring>]:<action>[#N]` where action
 * is `throw` (typed failure at the phase), `kill` (SIGKILL self — the
 * abrupt-death shape), or a lowercase errno (`eperm`/`ebusy`/`eacces`/
 * `erofs`/…) which throws an Error carrying that `.code` — the shape the
 * win32 transient-lock retry law classifies on. An optional `#N` fails only
 * the first N matching hits (contention that CLEARS — bounded retry becomes
 * provable without timing races). Multiple points separated by `;`. Exported
 * so the operation journal (and future durable machinery) can address ITS
 * phase boundaries through the same seam.
 */
export function faultPoint(phase: PublishFailurePhase | string, path: string): void {
  const spec = flagEnv('MERCURY_FAULT_INJECT')
  if (!spec) return
  for (const part of spec.split(';')) {
    const m = part.trim().match(/^([a-z-]+)(?:@(.+?))?:(throw|kill|[a-z]{3,10})(?:#(\d+))?$/)
    if (!m) continue
    if (m[1] !== phase) continue
    if (m[2] && !path.includes(m[2])) continue
    if (m[4]) {
      const key = `${spec}::${part.trim()}`
      const used = faultHitCounts.get(key) ?? 0
      if (used >= Number(m[4])) continue
      faultHitCounts.set(key, used + 1)
    }
    if (m[3] === 'kill') {
      process.kill(process.pid, 'SIGKILL')
    }
    if (m[3] === 'throw') {
      throw new Error(`injected fault at ${phase}`)
    }
    const err = new Error(`injected ${m[3]!.toUpperCase()} at ${phase}`) as NodeJS.ErrnoException
    err.code = m[3]!.toUpperCase()
    throw err
  }
}

/** TEST-ONLY: forget bounded-injection counters (a prover reusing one exact
 *  spec across cases resets between them). */
export function _resetFaultInjectionCountersForTests(): void {
  faultHitCounts.clear()
}

// One sweep per directory per process — publishes stay O(1) after the first.
const sweptDirs = new Set<string>()

/**
 * Remove stale orphan temps matching THIS primitive's pattern in `dir`.
 * Age-gated so a concurrent writer's live temp is never touched; never
 * deletes anything that does not match the pattern. Returns removed names.
 */
export async function cleanupOrphanDurableTemps(
  dir: string,
  opts?: { olderThanMs?: number },
): Promise<string[]> {
  const minAge = opts?.olderThanMs ?? ORPHAN_TEMP_MIN_AGE_MS
  const removed: string[] = []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return removed
  }
  const now = Date.now()
  for (const name of names) {
    if (!TEMP_PATTERN.test(name)) continue
    const full = join(dir, name)
    try {
      const st = await stat(full)
      if (now - st.mtimeMs < minAge) continue
      await unlink(full)
      removed.push(name)
    } catch {
      // raced another sweep / permission — leave it
    }
  }
  return removed
}

function sweepOnFirstUse(dir: string): void {
  if (sweptDirs.has(dir)) return
  sweptDirs.add(dir)
  void cleanupOrphanDurableTemps(dir).catch(() => {})
}

/**
 * Durably publish `contents` to `path`. See the module header for the exact
 * phase contract. Never leaves its own temp behind; never damages the prior
 * committed destination on failure. Returns the attempt/elapsed accounting.
 */
export async function durableAtomicPublish(
  path: string,
  contents: string | Uint8Array,
  opts?: DurablePublishOptions,
): Promise<DurablePublishReport> {
  const startedAt = Date.now()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  sweepOnFirstUse(dir)
  const tmp = durableTempName(path)
  let fh: Awaited<ReturnType<typeof open>> | null = null
  let phase: PublishFailurePhase = 'create-temp'
  let renameAttempts = 0
  try {
    faultPoint('create-temp', path)
    fh = await open(tmp, 'wx', opts?.mode ?? 0o666)
    phase = 'write'
    faultPoint('write', path)
    await fh.writeFile(contents)
    phase = 'flush-file'
    faultPoint('flush-file', path)
    if (fsyncEnabled()) await fh.sync()
    await fh.close()
    fh = null
    phase = 'rename'
    // The win32 bounded-retry law: the prepared (already-fsynced) temp stays
    // valid between attempts; the committed destination keeps serving readers.
    for (;;) {
      renameAttempts++
      try {
        faultPoint('rename', path)
        await rename(tmp, path)
        break
      } catch (e) {
        const delay = renameRetryDelayMs(errnoOf(e), renameAttempts)
        if (delay === null) throw e
        await sleepAsync(delay)
      }
    }
  } catch (e) {
    // cleanup: close + remove our own temp; the committed destination is
    // untouched (we never opened it).
    if (fh) await fh.close().catch(() => {})
    const tempCleanup: TempCleanupOutcome = await unlink(tmp).then(
      () => 'removed' as const,
      ue => (errnoOf(ue) === 'ENOENT' ? ('absent' as const) : ('remove-failed' as const)),
    )
    noteBudgetExhausted(path, errnoOf(e), Math.max(renameAttempts, 1), Date.now() - startedAt)
    throw new DurablePublishError(phase, path, e, {
      fsCode: errnoOf(e),
      attempts: Math.max(renameAttempts, 1),
      elapsedMs: Date.now() - startedAt,
      tempCleanup,
    })
  }
  // flush-dir: make the RENAME itself durable. Failure here is reported
  // (typed) but the publication is already visible to every reader.
  if (fsyncEnabled()) {
    try {
      faultPoint('flush-dir', path)
      const dh = await open(dir, 'r')
      try {
        await dh.sync()
      } finally {
        await dh.close()
      }
    } catch (e) {
      if (process.platform !== 'win32' && !isDirFsyncUnsupported(e)) {
        throw new DurablePublishError('flush-dir', path, e, {
          fsCode: errnoOf(e),
          attempts: renameAttempts,
          elapsedMs: Date.now() - startedAt,
          tempCleanup: 'renamed',
        })
      }
      // Windows (and some filesystems) cannot fsync a directory — the rename
      // is still atomic; durability of the rename follows the volume flush.
    }
  }
  if (renameAttempts > 1) noteRetriedSuccess(path, renameAttempts, Date.now() - startedAt)
  return {
    attempts: renameAttempts,
    elapsedMs: Date.now() - startedAt,
    retriedTransient: renameAttempts > 1,
  }
}

/**
 * Sync twin — for callers whose PUBLIC CONTRACT is synchronous and cannot
 * await: process-exit persistence hooks (critter profile, cache-clock
 * rollup), the settings write path
 * (updateSettingsForSource — sync from the start; core-ownership Phase 2 cut
 * it onto this primitive), and the daemon's concourse stores (dispatch +
 * control-op ledgers, worker roster, collision evidence, delta stamp —
 * sync handlers whose interleave-freedom is an audited invariant, R7
 * C-MED-1). Identical phase contract.
 */
export function durableAtomicPublishSync(
  path: string,
  contents: string | Uint8Array,
  opts?: DurablePublishOptions,
): DurablePublishReport {
  const startedAt = Date.now()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = durableTempName(path)
  let fd: number | null = null
  let phase: PublishFailurePhase = 'create-temp'
  let renameAttempts = 0
  try {
    faultPoint('create-temp', path)
    fd = openSync(tmp, 'wx', opts?.mode ?? 0o666)
    phase = 'write'
    faultPoint('write', path)
    const buf = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    phase = 'flush-file'
    faultPoint('flush-file', path)
    if (fsyncEnabled()) fsyncSync(fd)
    closeSync(fd)
    fd = null
    phase = 'rename'
    // The same win32 bounded-retry law as the async path (identical contract).
    for (;;) {
      renameAttempts++
      try {
        faultPoint('rename', path)
        renameSync(tmp, path)
        break
      } catch (e) {
        const delay = renameRetryDelayMs(errnoOf(e), renameAttempts)
        if (delay === null) throw e
        sleepSyncMs(delay)
      }
    }
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    let tempCleanup: TempCleanupOutcome
    try {
      unlinkSync(tmp)
      tempCleanup = 'removed'
    } catch (ue) {
      tempCleanup = errnoOf(ue) === 'ENOENT' ? 'absent' : 'remove-failed'
    }
    noteBudgetExhausted(path, errnoOf(e), Math.max(renameAttempts, 1), Date.now() - startedAt)
    throw new DurablePublishError(phase, path, e, {
      fsCode: errnoOf(e),
      attempts: Math.max(renameAttempts, 1),
      elapsedMs: Date.now() - startedAt,
      tempCleanup,
    })
  }
  if (fsyncEnabled()) {
    try {
      faultPoint('flush-dir', path)
      const dfd = openSync(dir, 'r')
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch (e) {
      if (process.platform !== 'win32' && !isDirFsyncUnsupported(e)) {
        throw new DurablePublishError('flush-dir', path, e, {
          fsCode: errnoOf(e),
          attempts: renameAttempts,
          elapsedMs: Date.now() - startedAt,
          tempCleanup: 'renamed',
        })
      }
    }
  }
  if (renameAttempts > 1) noteRetriedSuccess(path, renameAttempts, Date.now() - startedAt)
  return {
    attempts: renameAttempts,
    elapsedMs: Date.now() - startedAt,
    retriedTransient: renameAttempts > 1,
  }
}

/** Directory fsync unsupported on this platform/filesystem (EISDIR on some
 *  BSDs, EPERM/EACCES/EINVAL/ENOTSUP on exotic mounts) — treated as a
 *  documented no-op, never a publication failure. */
function isDirFsyncUnsupported(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  return (
    code === 'EISDIR' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EBADF'
  )
}

/** TEST-ONLY: forget the per-process swept-dir memo. */
export function _resetSweepMemoForTests(): void {
  sweptDirs.clear()
}
