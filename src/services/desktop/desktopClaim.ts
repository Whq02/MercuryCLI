import { mkdir, readFile } from 'node:fs/promises'
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
import { safeParseJSON } from '../../utils/json.js'
import {
  IDLE_DESKTOP_SNAPSHOT,
  desktopSnapshot,
  drivingAppOf,
  drivingAppOfSnapshot,
  publishDesktopDriving,
  publishDesktopIdle,
  sameDrivingApp,
  subscribeDesktop,
  type DesktopDrivingApp,
  type DesktopDrivingAppInput,
  type DesktopSnapshot,
} from './desktopSession.js'

export const DESKTOP_CLAIM_FILE = 'desktop.lock'
export const DESKTOP_CLAIM_IDLE_RELEASE_MS = 30_000
export const DESKTOP_CLAIM_POLL_MS = 500

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

export type DesktopClaimRecord = {
  app: DesktopDrivingApp | null
  since: number
}

let held = false
let recordApp: DesktopDrivingApp | null = null
let claimedSince: number | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let claiming: Promise<DesktopClaimVerdict> | null = null
let releasing: Promise<void> | null = null
let restamping: Promise<boolean> | null = null
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

function recordOf(app: DesktopDrivingApp | null, since: number): DesktopClaimRecord {
  return { app, since }
}

async function acquire(app: DesktopDrivingApp | null): Promise<DesktopClaimVerdict> {
  await mkdir(daemonDir(), { recursive: true }).catch(() => undefined)
  const since = Date.now()
  const result = await acquirePidLock(desktopClaimPath(), desktopClaimOwner(), {
    liveness: 'assume-dead',
    extra: recordOf(app, since),
  })
  if (!result.held) return { held: false, holder: result.by ?? null }
  held = true
  recordApp = app
  claimedSince = since
  return { held: true }
}

async function restamp(app: DesktopDrivingApp | null): Promise<boolean> {
  if (!held) return false
  if (restamping !== null) {
    await restamping
    if (!held) return false
  }
  if (sameDrivingApp(app, recordApp)) return true
  restamping = (async () => {
    const path = desktopClaimPath()
    const since = claimedSince ?? Date.now()
    noteLockRelease(`desktop claim ${path} (restamp)`, await releasePidLock(path, desktopClaimOwner()))
    const result = await acquirePidLock(path, desktopClaimOwner(), { liveness: 'assume-dead', extra: recordOf(app, since) })
    if (!result.held) {
      held = false
      recordApp = null
      claimedSince = null
      clearIdleTimer()
      publishDesktopIdle()
      logForDebugging(`desktop claim: lost to pid ${result.by?.pid ?? 'unknown'} while recording ${app?.name ?? 'no application'}`)
      return false
    }
    recordApp = app
    claimedSince = since
    return true
  })().finally(() => {
    restamping = null
  })
  return restamping
}

export async function claimDesktop(signal: AbortSignal, app: DesktopDrivingAppInput = null): Promise<DesktopClaimVerdict> {
  if (signal.aborted) return { held: false, holder: null, aborted: true }
  if (releasing !== null) await releasing
  const driving = drivingAppOf(app)
  if (!held) {
    if (claiming === null) {
      claiming = acquire(driving).finally(() => {
        claiming = null
      })
    }
    const verdict = await claiming
    if (!verdict.held) return verdict
  } else if (driving !== null && !(await restamp(driving))) {
    return { held: false, holder: await probeDesktopLock() }
  }
  if (signal.aborted) {
    await releaseDesktopClaim()
    return { held: false, holder: null, aborted: true }
  }
  armAbortRelease(signal)
  publishDesktopDriving(driving)
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

export function desktopClaimRecord(): DesktopClaimRecord | null {
  return held ? recordOf(recordApp, claimedSince ?? 0) : null
}

export async function releaseDesktopClaim(): Promise<void> {
  clearIdleTimer()
  if (releasing !== null) return releasing
  if (!held) {
    publishDesktopIdle()
    return
  }
  held = false
  recordApp = null
  claimedSince = null
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

function recordFromText(text: string): DesktopClaimRecord | null {
  const parsed = safeParseJSON(text, false) as { app?: unknown; since?: unknown } | null
  if (!parsed || typeof parsed !== 'object') return null
  const app = parsed.app
  const named =
    app !== null &&
    typeof app === 'object' &&
    typeof (app as { name?: unknown }).name === 'string' &&
    typeof (app as { identity?: unknown }).identity === 'string'
      ? { identity: (app as { identity: string }).identity, name: (app as { name: string }).name }
      : null
  return recordOf(named, typeof parsed.since === 'number' ? parsed.since : 0)
}

export async function readDesktopClaimRecord(): Promise<DesktopClaimRecord | null> {
  try {
    return recordFromText(await readFile(desktopClaimPath(), 'utf8'))
  } catch {
    return null
  }
}

export async function readDesktopClaimFile(): Promise<DesktopSnapshot> {
  const holder = await probePidLock(desktopClaimPath(), { liveness: 'assume-dead' })
  if (holder === null) return IDLE_DESKTOP_SNAPSHOT
  const record = await readDesktopClaimRecord()
  return {
    phase: 'driving',
    app: record?.app?.name ?? null,
    identity: record?.app?.identity ?? null,
    startedAt: record !== null && record.since > 0 ? record.since : holder.acquiredAt,
  }
}

let fileView: DesktopSnapshot = IDLE_DESKTOP_SNAPSHOT
const fileListeners = new Set<() => void>()
let poll: ReturnType<typeof setInterval> | null = null
let reading = false

function sameSnapshot(a: DesktopSnapshot, b: DesktopSnapshot): boolean {
  return a.phase === b.phase && a.app === b.app && a.identity === b.identity && a.startedAt === b.startedAt
}

function publishFileView(next: DesktopSnapshot): void {
  if (sameSnapshot(next, fileView)) return
  fileView = next
  for (const listener of [...fileListeners]) {
    try {
      listener()
    } catch (error) {
      logForDebugging(`desktop claim: a file view listener failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function readFileView(): Promise<void> {
  if (reading) return
  reading = true
  try {
    publishFileView(await readDesktopClaimFile())
  } catch (error) {
    logForDebugging(`desktop claim: the file view read failed — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    reading = false
  }
}

export function subscribeDesktopClaimFile(listener: () => void): () => void {
  fileListeners.add(listener)
  return () => {
    fileListeners.delete(listener)
  }
}

export function desktopClaimFileSnapshot(): DesktopSnapshot {
  return fileView
}

export function armDesktopClaimPoll(active: boolean): void {
  if (active) {
    if (poll !== null) return
    poll = setInterval(() => {
      void readFileView()
    }, DESKTOP_CLAIM_POLL_MS)
    poll.unref?.()
    void readFileView()
    return
  }
  if (poll !== null) {
    clearInterval(poll)
    poll = null
  }
  publishFileView(IDLE_DESKTOP_SNAPSHOT)
}

export function desktopClaimPollArmed(): boolean {
  return poll !== null
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
  armDesktopClaimPoll(false)
  owner = null
}

subscribeDesktop(() => {
  if (!held) return
  const view = desktopSnapshot()
  if (view.phase !== 'driving') return
  void restamp(drivingAppOfSnapshot(view))
})

registerCleanup(async () => {
  await releaseDesktopClaim()
})
