import { statSync, readFileSync, rmdirSync, existsSync, unlinkSync, mkdirSync, realpathSync, utimesSync } from 'node:fs'
import { dirname } from 'node:path'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { STORE_LOCK_OPTIONS } from '../../platform/substrate/fileStore.js'
import { lockSync } from '../../platform/storage/lockfile.js'
import { publishTransientInDaemonHome, daemonHomeStands, ensureDirInDaemonHome } from '../control/daemonHome.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { sleepSync } from '../../platform/async/timers.js'

const SESSION_RECORDS_LOCK_WAIT_MS = STORE_LOCK_OPTIONS.stale + 5_000

class SessionRecordsLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionRecordsLockError'
  }
}

function lockIdentityOf(lockDir: string): string | null {
  try {
    const st = statSync(lockDir)
    return `${st.ino}:${st.mtimeMs}`
  } catch (error) {
    passedOver(error)
    return null
  }
}

type SessionRecordsLock = { release: () => void; stillHeld: () => boolean }

function abandonedLockReading(lockDir: string, ownerPath: string): string | null {
  let owner: string
  try {
    owner = readFileSync(ownerPath, 'utf8')
  } catch (error) {
    passedOver(error)
    return null
  }
  const pid = Number(owner.trim())
  if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) return null
  const identity = lockIdentityOf(lockDir)
  return identity === null ? null : `${identity}|${pid}`
}

function reclaimAbandonedLock(lockDir: string, ownerPath: string): boolean {
  const judged = abandonedLockReading(lockDir, ownerPath)
  if (judged === null) return false
  sleepSync(50)
  if (abandonedLockReading(lockDir, ownerPath) !== judged) return false
  if (lockIdentityOf(lockDir) !== judged.split('|')[0]) return false
  try {
    rmdirSync(lockDir)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  if (!existsSync(lockDir)) {
    try {
      unlinkSync(ownerPath)
    } catch (error) { passedOver(error) }
  }
  return true
}

function acquireSessionRecordsLock(
  path: string,
  dir: string | undefined,
  where: string = 'the session records',
): SessionRecordsLock | 'home-gone' {
  const lockDir = `${path}.lock`
  const ownerPath = `${lockDir}.owner`
  const deadline = Date.now() + SESSION_RECORDS_LOCK_WAIT_MS
  let backoffMs = 2
  let parentCreated = false
  for (;;) {
    try {
      let acquired = false
      let identity: string | null = null
      const stillHeld = (): boolean => identity !== null && lockIdentityOf(lockDir) === identity
      const release = lockSync(path, {
        lockfilePath: lockDir,
        realpath: false,
        stale: STORE_LOCK_OPTIONS.stale,
        fs: {
          mkdirSync,
          realpathSync,
          statSync,
          utimesSync,
          rmdirSync: ((target: string) => {
            if (acquired && !stillHeld()) return
            rmdirSync(target)
          }) as typeof rmdirSync,
        },
        onCompromised: (err: Error) => {
          logForDebugging(`[concourse] ${where} lock was compromised: ${err.message}`, { level: 'warn' })
        },
      })
      try {
        publishTransientInDaemonHome(where, ownerPath, `${process.pid}\n`, dir)
      } catch (error) { passedOver(error) }
      identity = lockIdentityOf(lockDir)
      acquired = true
      return {
        stillHeld,
        release: () => {
          if (stillHeld()) {
            try {
              unlinkSync(ownerPath)
            } catch (error) { passedOver(error) }
          }
          release()
        },
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') {
        if (!daemonHomeStands(where, dir)) return 'home-gone'
        if (parentCreated) throw err
        if (!ensureDirInDaemonHome(where, dirname(path), dir)) return 'home-gone'
        parentCreated = true
        continue
      }
      if (code !== 'ELOCKED') throw err
      if (reclaimAbandonedLock(lockDir, ownerPath)) continue
      if (Date.now() >= deadline) {
        logForDebugging(`[concourse] ${where} at ${path} were not updated: another writer held its lock for ${SESSION_RECORDS_LOCK_WAIT_MS} ms`, { level: 'error' })
        throw new SessionRecordsLockError("the daemon's session records were busy — try again")
      }
      sleepSync(backoffMs + Math.floor(Math.random() * backoffMs))
      backoffMs = Math.min(backoffMs * 2, 50)
    }
  }
}

const daemonStoreLocksInFlight = new Map<string, SessionRecordsLock | 'home-gone'>()

export function withDaemonStoreLock<T>(
  where: string,
  path: string,
  dir: string | undefined,
  run: (ctx: { homeGone: boolean; assertStillHeld: () => void }) => T,
): T {
  const existing = daemonStoreLocksInFlight.get(path)
  if (existing !== undefined) {
    return run({
      homeGone: existing === 'home-gone',
      assertStillHeld: () => {
        if (existing !== 'home-gone' && !existing.stillHeld()) {
          throw new SessionRecordsLockError(`${where} at ${path} were not updated: its lock was lost before the publish`)
        }
      },
    })
  }
  const lock = daemonHomeStands(where, dir) ? acquireSessionRecordsLock(path, dir, where) : 'home-gone'
  daemonStoreLocksInFlight.set(path, lock)
  try {
    return run({
      homeGone: lock === 'home-gone',
      assertStillHeld: () => {
        if (lock !== 'home-gone' && !lock.stillHeld()) {
          throw new SessionRecordsLockError(`${where} at ${path} were not updated: its lock was lost before the publish`)
        }
      },
    })
  } finally {
    daemonStoreLocksInFlight.delete(path)
    if (lock !== 'home-gone') {
      try {
        lock.release()
      } catch (err) {
        logForDebugging(`[concourse] ${where} lock was not released: ${err}`, { level: 'warn' })
      }
    }
  }
}
