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

export type TempCleanupOutcome = 'renamed' | 'removed' | 'absent' | 'remove-failed'

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
  public readonly fsCode: string | undefined
  public readonly attempts: number
  public readonly elapsedMs: number
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

function errnoOf(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export interface DurablePublishOptions {
  mode?: number
}

const TEMP_PATTERN = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/

const ORPHAN_TEMP_MIN_AGE_MS = 10 * 60_000

export function durableTempName(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  )
}

export function isDurableTempName(name: string): boolean {
  return TEMP_PATTERN.test(name)
}


export const WIN32_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200]

export function isTransientWin32FsCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

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

function isReadOnlyDestination(to: string): boolean {
  try {
    const stats = statSync(to)
    return stats.isFile() && (stats.mode & 0o200) === 0
  } catch {
    return false
  }
}


export interface DurablePublishHealth {
  budgetExhausted: {
    count: number
    last: { path: string; fsCode?: string; attempts: number; elapsedMs: number; atMs: number } | null
  }
  retriedSuccesses: {
    count: number
    last: { path: string; attempts: number; elapsedMs: number; atMs: number } | null
  }
}

const publishHealth: DurablePublishHealth = {
  budgetExhausted: { count: 0, last: null },
  retriedSuccesses: { count: 0, last: null },
}

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
  if (!isTransientWin32FsCode(fsCode) || attempts <= 1) return
  publishHealth.budgetExhausted.count += 1
  publishHealth.budgetExhausted.last = { path, fsCode, attempts, elapsedMs, atMs: Date.now() }
}

function noteRetriedSuccess(path: string, attempts: number, elapsedMs: number): void {
  publishHealth.retriedSuccesses.count += 1
  publishHealth.retriedSuccesses.last = { path, attempts, elapsedMs, atMs: Date.now() }
}

export function _resetDurablePublishHealthForProofs(): void {
  publishHealth.budgetExhausted = { count: 0, last: null }
  publishHealth.retriedSuccesses = { count: 0, last: null }
}

const sleepSyncMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

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

const faultHitCounts = new Map<string, number>()

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

export function _resetFaultInjectionCountersForTests(): void {
  faultHitCounts.clear()
}

const sweptDirs = new Set<string>()

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
    }
  }
  return removed
}

function sweepOnFirstUse(dir: string): void {
  if (sweptDirs.has(dir)) return
  sweptDirs.add(dir)
  void cleanupOrphanDurableTemps(dir).catch(() => {})
}

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
    }
  }
  if (renameAttempts > 1) noteRetriedSuccess(path, renameAttempts, Date.now() - startedAt)
  return {
    attempts: renameAttempts,
    elapsedMs: Date.now() - startedAt,
    retriedTransient: renameAttempts > 1,
  }
}

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

export function _resetSweepMemoForTests(): void {
  sweptDirs.clear()
}
