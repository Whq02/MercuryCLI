import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { daemonDir } from '../../daemon/controlSocket.js'
import {
  acquirePidLock,
  noteLockRelease,
  probePidLock,
  releasePidLock,
  type PidLockHolder,
} from '../../substrate/pidLock.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { publishDesktopDriving, publishDesktopIdle } from './desktopSession.js'

export const DESKTOP_CLAIM_FILE = 'desktop.lock'
export const DESKTOP_CLAIM_IDLE_RELEASE_MS = 30_000

export function desktopClaimPath(): string {
  return join(daemonDir(), DESKTOP_CLAIM_FILE)
}

function sessionWord(): string {
  try {
    return String(getSessionId())
  } catch {
    return 'boot'
  }
}

let owner: string | null = null

export function desktopClaimOwner(): string {
  if (owner === null) owner = `${sessionWord()}:${process.pid}`
  return owner
}

export type DesktopClaimVerdict =
  | { held: true }
  | { held: false; holder: PidLockHolder | null; aborted?: true }

let held = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
let claiming: Promise<DesktopClaimVerdict> | null = null
let releasing: Promise<void> | null = null
const armedSignals = new WeakSet<AbortSignal>()

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function armAbortRelease(signal: AbortSignal): void {
  if (armedSignals.has(signal)) return
  armedSignals.add(signal)
  signal.addEventListener(
    'abort',
    () => {
      void releaseDesktopClaim()
    },
    { once: true },
  )
}

async function acquire(): Promise<DesktopClaimVerdict> {
  await mkdir(daemonDir(), { recursive: true }).catch(() => undefined)
  const result = await acquirePidLock(desktopClaimPath(), desktopClaimOwner(), { liveness: 'assume-dead' })
  if (!result.held) return { held: false, holder: result.by ?? null }
  held = true
  return { held: true }
}

export async function claimDesktop(signal: AbortSignal, app: string | null = null): Promise<DesktopClaimVerdict> {
  if (signal.aborted) return { held: false, holder: null, aborted: true }
  if (releasing !== null) await releasing
  if (!held) {
    if (claiming === null) {
      claiming = acquire().finally(() => {
        claiming = null
      })
    }
    const verdict = await claiming
    if (!verdict.held) return verdict
  }
  if (signal.aborted) {
    await releaseDesktopClaim()
    return { held: false, holder: null, aborted: true }
  }
  armAbortRelease(signal)
  publishDesktopDriving(app)
  renewDesktopClaim()
  return { held: true }
}

export function renewDesktopClaim(): void {
  if (!held) return
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    void releaseDesktopClaimForIdle()
  }, DESKTOP_CLAIM_IDLE_RELEASE_MS)
  idleTimer.unref?.()
}

export function desktopClaimHeld(): boolean {
  return held
}

export async function releaseDesktopClaim(): Promise<void> {
  clearIdleTimer()
  if (releasing !== null) return releasing
  if (!held) {
    publishDesktopIdle()
    return
  }
  held = false
  publishDesktopIdle()
  releasing = releasePidLock(desktopClaimPath(), desktopClaimOwner())
    .then(receipt => {
      noteLockRelease(`desktop claim ${desktopClaimPath()}`, receipt)
    })
    .catch(error => {
      logForDebugging(`desktop claim: release failed — ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(() => {
      releasing = null
    })
  return releasing
}

export async function releaseDesktopClaimForIdle(): Promise<void> {
  if (!held) return
  logForDebugging(`desktop claim: no act for ${DESKTOP_CLAIM_IDLE_RELEASE_MS / 1000}s — released for other sessions`)
  await releaseDesktopClaim()
}

export async function probeDesktopLock(): Promise<PidLockHolder | null> {
  return probePidLock(desktopClaimPath(), { liveness: 'assume-dead', reclaimStale: true })
}

export function claimAgeWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'a moment'
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

export function desktopClaimBusyNote(holder: PidLockHolder | null): string {
  if (holder === null) return 'the desktop could not be claimed — one driver at a time; try again in a moment'
  return `another session is driving the desktop (pid ${holder.pid}, for ${claimAgeWords(Date.now() - holder.acquiredAt)}) — one driver at a time; wait for its turn to end`
}

export async function resetDesktopClaimForTest(): Promise<void> {
  await releaseDesktopClaim()
  owner = null
}

registerCleanup(async () => {
  await releaseDesktopClaim()
})
