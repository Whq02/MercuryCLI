import { mkdir, readFileSync, rmSync, rmdir, rmdirSync, stat, statSync, utimes, writeFileSync } from 'node:fs'
import { pollUntil, withDeadline } from '../../../platform/async/deadline.js'
import { getErrnoCode, isENOENT } from '../../../platform/errors/errors.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { pidAlive } from '../../../platform/processes/pidAlive.js'
import { lock } from '../../../platform/storage/lockfile.js'

const LOCK_POLL_MS = 100
const LOCK_STALE_MARGIN_MS = 2_000
const LOCK_PATIENCE_MARGIN_MS = 1_000
const REFRESH_LOCK_FILE_STALE_MS = 30_000

type RefreshLockFile = 'stale-by-age' | 'stale-by-holder'

interface RefreshablePair {
  accessToken: string
  refreshToken?: string
}

type RefreshExchange<T> = { state: 'refreshed'; pair: T } | { state: 'dead'; error: unknown }

export interface LockedRefreshRoad<T extends RefreshablePair> {
  path: string
  exchangeDeadlineMs: number
  refreshLockFile?: RefreshLockFile
  force?: boolean
  signal?: AbortSignal
  read(): T | undefined
  write(pair: T): void
  fresh(pair: T): boolean
  exchange(old: T): Promise<RefreshExchange<T>>
}

export type LockedRefreshAnswer<T> =
  | { state: 'refreshed'; pair: T }
  | { state: 'current'; pair: T }
  | { state: 'absent' }
  | { state: 'dead'; pair: T; error: unknown }
  | { state: 'busy'; pair: T }
  | { state: 'failed'; pair: T; error: unknown }

type Due<T> = { state: 'due'; pair: T; stored: T; refreshToken: string }

function samePair(a: RefreshablePair, b: RefreshablePair): boolean {
  return a.refreshToken === b.refreshToken && a.accessToken === b.accessToken
}

function unlessHeld(error: unknown): undefined {
  if (getErrnoCode(error) === 'ELOCKED') return undefined
  throw error
}

function lockOwnedUntilStale(path: string, stale: number): Promise<() => Promise<void>> {
  const asked = Date.now()
  const lapsed = (): boolean => Date.now() - asked >= stale
  return lock(path, {
    realpath: false,
    stale,
    onCompromised: passedOver,
    fs: {
      mkdir,
      stat,
      utimes,
      rmdir: (dir: string, done: (error: NodeJS.ErrnoException | null) => void): void => (lapsed() ? done(null) : rmdir(dir, done)),
      rmdirSync: (dir: string): void => {
        if (!lapsed()) rmdirSync(dir)
      },
    },
  })
}

function refreshLockFileStale(path: string, rule: RefreshLockFile, stamp: string): boolean {
  const [holder, stampedAt] = stamp.trim().split(/\s+/).map(Number)
  if (rule === 'stale-by-holder' && holder !== undefined && Number.isSafeInteger(holder) && holder > 0 && !pidAlive(holder)) return true
  const since = rule === 'stale-by-age' && stampedAt !== undefined && Number.isFinite(stampedAt) ? stampedAt : statSync(path).mtimeMs
  return Date.now() - since > REFRESH_LOCK_FILE_STALE_MS
}

function clearStaleRefreshLockFile(path: string, rule: RefreshLockFile, own: string | undefined): void {
  try {
    const stamp = readFileSync(path, 'utf8')
    if ((stamp === own || refreshLockFileStale(path, rule, stamp)) && readFileSync(path, 'utf8') === stamp) rmSync(path)
  } catch (error) {
    if (!isENOENT(error)) passedOver(error)
  }
}

function takeRefreshLockFile(path: string, rule: RefreshLockFile, ownStamps: Map<string, string>): (() => void) | undefined {
  const stamp = `${process.pid} ${Date.now()}\n`
  try {
    writeFileSync(path, stamp, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
    clearStaleRefreshLockFile(path, rule, ownStamps.get(path))
    return undefined
  }
  ownStamps.set(path, stamp)
  return () => {
    try {
      if (readFileSync(path, 'utf8') === stamp) rmSync(path)
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    ownStamps.delete(path)
  }
}

async function bothLocks(road: Pick<LockedRefreshRoad<RefreshablePair>, 'path' | 'refreshLockFile'>, stale: number, ownStamps: Map<string, string>): Promise<(() => Promise<void>) | undefined> {
  const leaveFile = road.refreshLockFile === undefined ? (): void => {} : takeRefreshLockFile(`${road.path}.refresh-lock`, road.refreshLockFile, ownStamps)
  if (leaveFile === undefined) return undefined
  let kept = false
  try {
    const leaveFolder = await lockOwnedUntilStale(road.path, stale).catch(unlessHeld)
    kept = leaveFolder !== undefined
    return leaveFolder && (() => leaveFolder().finally(leaveFile))
  } finally {
    if (!kept) leaveFile()
  }
}

export function lockedRefresh<T extends RefreshablePair>(): (road: LockedRefreshRoad<T>) => Promise<LockedRefreshAnswer<T>> {
  const joined = new Map<string, Promise<LockedRefreshAnswer<T>>>()
  const unsaved = new Map<string, { replaces: T; pair: T }>()
  const dead = new Map<string, unknown>()
  const ownStamps = new Map<string, string>()

  function standing(road: LockedRefreshRoad<T>, began: T | undefined): LockedRefreshAnswer<T> | Due<T> {
    const stored = road.read()
    const held = unsaved.get(road.path)
    const kept = held !== undefined && stored !== undefined && samePair(stored, held.replaces) ? held.pair : undefined
    if (held !== undefined && kept === undefined) unsaved.delete(road.path)
    const pair = kept ?? stored
    const refreshToken = pair?.refreshToken
    if (stored === undefined || pair === undefined || !refreshToken) return { state: 'absent' }
    if (dead.has(refreshToken)) return { state: 'dead', pair, error: dead.get(refreshToken) }
    const forced = road.force === true && (began === undefined || samePair(pair, began))
    return road.fresh(pair) && !forced ? { state: 'current', pair } : { state: 'due', pair, stored, refreshToken }
  }

  function saveUnsaved(road: LockedRefreshRoad<T>): void {
    const held = unsaved.get(road.path)
    const stored = road.read()
    if (held === undefined || stored === undefined || !samePair(stored, held.replaces)) return
    try {
      road.write(held.pair)
      unsaved.delete(road.path)
    } catch (error) {
      passedOver(error)
    }
  }

  async function exchange(road: LockedRefreshRoad<T>, due: Due<T>): Promise<LockedRefreshAnswer<T>> {
    let exchanged: RefreshExchange<T> | { state: 'failed'; error: unknown }
    try {
      exchanged = await road.exchange(due.pair)
    } catch (error) {
      exchanged = { state: 'failed', error }
    }
    const after = road.read()
    const blanked = exchanged.state === 'refreshed' && after?.refreshToken === '' && after.accessToken === due.stored.accessToken
    if (after === undefined || !(blanked || samePair(after, due.stored))) return after?.refreshToken ? { state: 'current', pair: after } : { state: 'absent' }
    if (exchanged.state === 'failed') return { state: 'failed', pair: due.pair, error: exchanged.error }
    if (exchanged.state === 'dead') {
      dead.set(due.refreshToken, exchanged.error)
      unsaved.delete(road.path)
      try {
        road.write({ ...due.pair, refreshToken: '' })
      } catch (error) {
        logError(error)
      }
      return { state: 'dead', pair: due.pair, error: exchanged.error }
    }
    try {
      road.write(exchanged.pair)
      unsaved.delete(road.path)
    } catch (error) {
      unsaved.set(road.path, { replaces: after, pair: exchanged.pair })
      logError(error)
    }
    return { state: 'refreshed', pair: exchanged.pair }
  }

  async function refresh(road: LockedRefreshRoad<T>, began: T | undefined): Promise<LockedRefreshAnswer<T>> {
    const stale = road.exchangeDeadlineMs + LOCK_STALE_MARGIN_MS
    let release: (() => Promise<void>) | null = null
    let unusable: { error: unknown } | undefined
    try {
      release = await pollUntil(() => bothLocks(road, stale, ownStamps), LOCK_POLL_MS, stale + LOCK_PATIENCE_MARGIN_MS, () => null)
    } catch (error) {
      unusable = { error }
    }
    if (release === null) {
      const waited = standing(road, began)
      if (waited.state !== 'due') return waited
      return unusable ? { state: 'failed', pair: waited.pair, error: unusable.error } : { state: 'busy', pair: waited.pair }
    }
    try {
      saveUnsaved(road)
      const under = standing(road, began)
      return under.state === 'due' ? await exchange(road, under) : under
    } finally {
      await release().catch(passedOver)
    }
  }

  return road => {
    const first = standing(road, undefined)
    if (first.state !== 'due' && !unsaved.has(road.path)) return Promise.resolve(first)
    const existing = joined.get(road.path)
    const work = existing ?? refresh(road, first.state === 'absent' ? undefined : first.pair).finally(() => joined.delete(road.path))
    if (existing === undefined) joined.set(road.path, work)
    if (road.signal === undefined) return work
    const leaves = (): LockedRefreshAnswer<T> => (first.state === 'due' ? { state: 'busy', pair: first.pair } : first)
    return withDeadline(work, Number.POSITIVE_INFINITY, leaves, { signal: road.signal, onAbort: leaves })
  }
}
