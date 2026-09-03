
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
import { procLiveToken, currentProcStart } from '../utils/genericProcessUtils.js'
import { getProcessStartTokenAsync, getProcessStartTokenCachedOrRefresh } from '../daemon/ownerWatch.js'
import { safeParseJSON } from '../utils/json.js'
import { sleep } from '../utils/sleep.js'
import { jsonStringify } from '../utils/slowOperations.js'

export type LivenessPolarity = 'assume-alive' | 'assume-dead'

async function currentProcStartAnyPlatform(): Promise<{ procStartField: { procStart: string } | Record<string, never> }> {
  const local = currentProcStart()
  if (local) return { procStartField: { procStart: local } }
  const probed = await getProcessStartTokenAsync(process.pid)
  return { procStartField: probed ? { procStart: probed } : {} }
}

async function liveTokenFor(holder: PidLockHolder | null): Promise<string | null | undefined> {
  if (!holder?.procStart) return undefined
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

async function readRawRecord(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

const REAP_CONFIRM_MS = 150

export function holderAlive(
  holder: PidLockHolder,
  polarity: LivenessPolarity,
  liveToken?: string | null,
): boolean {
  if (holder.pid <= 1) return polarity === 'assume-alive'
  try {
    process.kill(holder.pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false
    return polarity === 'assume-alive'
  }
  if (holder.procStart) {
    const current =
      liveToken !== undefined ? liveToken : (procLiveToken(holder.pid) ?? getProcessStartTokenCachedOrRefresh(holder.pid))
    if (current === '') return false
    if (current !== null && current !== undefined && current !== holder.procStart) return false
  }
  return true
}

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

export async function acquirePidLock(
  path: string,
  owner: string,
  opts: {
    liveness: LivenessPolarity
    extra?: Record<string, unknown>
  },
): Promise<PidLockAcquire> {
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
    if (holder && holderAlive(holder, opts.liveness, await liveTokenFor(holder))) {
      return { held: false, by: holder }
    }
    const judged = await readRawRecord(path)
    if (judged === null) continue
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


export interface PidLockReleaseReceipt {
  outcome: 'removed' | 'absent' | 'not-held' | 'deferred' | 'failed'
  attempts: number
  fsCode?: string
}

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

export function _resetPidLockReleaseHealthForProofs(): void {
  releaseHealth.notRemoved = { count: 0, last: null }
  releaseHealth.retriedSuccesses = { count: 0, last: null }
}

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
      if (code === 'ENOENT') return settle({ outcome: 'removed', attempts: attempt })
      if (code === undefined) code = 'EUNKNOWN'
    }
    if (code === undefined) {
      const after = await readRaw(path)
      if (after.kind === 'missing') return settle({ outcome: 'removed', attempts: attempt })
      if (after.kind === 'ok') {
        const afterHolder = parseHolder(after.raw)
        if (!afterHolder || afterHolder.owner !== owner) {
          return settle({ outcome: 'removed', attempts: attempt })
        }
      }
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

export async function probePidLock(
  path: string,
  opts: { liveness: LivenessPolarity; reclaimStale?: boolean },
): Promise<PidLockHolder | null> {
  const holder = await readHolder(path)
  if (!holder) return null
  if (holderAlive(holder, opts.liveness, await liveTokenFor(holder))) return holder
  if (opts.reclaimStale) {
    const judged = await readRawRecord(path)
    if (judged === null) return null
    await sleep(REAP_CONFIRM_MS)
    if ((await readRawRecord(path)) !== judged) return null
    const taken = `${path}.reap-${process.pid}-${randomUUID().slice(0, 8)}`
    try {
      await renameWithWin32Retry(path, taken)
    } catch {
      return null
    }
    const takenHolder = parseHolder((await readRawRecord(taken)) ?? '')
    if (takenHolder && holderAlive(takenHolder, opts.liveness, await liveTokenFor(takenHolder))) {
      await link(taken, path).catch(() => {})
    }
    await unlink(taken).catch(() => {})
  }
  return null
}
