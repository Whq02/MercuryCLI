import { spawn, type ChildProcess } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'

import { registerCleanup } from '../utils/cleanupRegistry.js'

/**
 * Ref-counted macOS idle-sleep suppression via a self-expiring helper
 * process. A no-op on every other platform — the platform check lives in
 * the spawn/arm helpers, so off macOS the counter still moves and nothing
 * is externally observable.
 */

// The helper self-expires after 300 s, so a SIGKILLed product leaves no
// orphan; the restart timer refreshes it comfortably inside that window.
const CAFFEINATE_TIMEOUT_SECONDS = 300
const RESTART_INTERVAL_MS = 240_000

let referenceCount = 0
let helper: ChildProcess | null = null
let restartTimer: NodeJS.Timeout | null = null
let cleanupRegistered = false

function spawnHelper(): void {
  if (process.platform !== 'darwin') return
  if (helper !== null) return
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      forceStopPreventSleep()
    })
  }
  try {
    // Idle-sleep-only assertion (the least aggressive form — the display
    // may still sleep) with the self-expiry timeout.
    const child = spawn('caffeinate', ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)], {
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
      env: { ...subprocessEnv() },
    })
    child.unref()
    child.on('error', () => {
      // A failed spawn is silent — the machine simply may sleep. Clear only
      // if this is still the tracked handle (a respawn must not be
      // clobbered by the old process's late event).
      if (helper === child) helper = null
    })
    child.on('exit', () => {
      if (helper === child) helper = null
    })
    helper = child
  } catch {
    // Silent: no suppression.
  }
}

function killHelper(): void {
  if (helper === null) return
  try {
    helper.kill('SIGKILL')
  } catch {
    // Already exited.
  }
  helper = null
}

function armRestartTimer(): void {
  if (process.platform !== 'darwin') return
  if (restartTimer !== null) return
  restartTimer = setInterval(() => {
    if (referenceCount > 0) {
      killHelper()
      spawnHelper()
    }
  }, RESTART_INTERVAL_MS)
  restartTimer.unref()
}

function disarmRestartTimer(): void {
  if (restartTimer !== null) {
    clearInterval(restartTimer)
    restartTimer = null
  }
}

export function startPreventSleep(): void {
  referenceCount++
  if (referenceCount === 1) {
    spawnHelper()
    armRestartTimer()
  }
}

export function stopPreventSleep(): void {
  referenceCount = Math.max(0, referenceCount - 1)
  if (referenceCount === 0) {
    disarmRestartTimer()
    killHelper()
  }
}

/** Exit cleanup: reset the count and tear down unconditionally. */
export function forceStopPreventSleep(): void {
  referenceCount = 0
  disarmRestartTimer()
  killHelper()
}
