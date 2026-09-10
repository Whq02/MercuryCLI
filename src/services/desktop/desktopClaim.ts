import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { conversationIdHere, subscribeFocusedSessionConnector } from '../engine-connector/focusedConnector.js'
import { daemonDir } from '../../daemon/controlSocket.js'
import {
  acquirePidLock,
  noteLockRelease,
  probePidLock,
  releasePidLock,
  restampPidLock,
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
let mutation: Promise<void> = Promise.resolve()
let releaseEpoch = 0
let pendingClaims = 0
let actInFlight = false
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

function serializeClaim<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutation.then(operation, operation)
  mutation = result.then(() => undefined, () => undefined)
  return result
}

async function releaseOwnedClaim(): Promise<void> {
  clearIdleTimer()
  held = false
  actInFlight = false
  recordApp = null
  claimedSince = null
  publishDesktopIdle()
  try {
    noteLockRelease(`desktop claim ${desktopClaimPath()}`, await releasePidLock(desktopClaimPath(), desktopClaimOwner()))
  } catch (error) {
    logForDebugging(`desktop claim: release failed — ${error instanceof Error ? error.message : String(error)}`)
  }
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
  if (sameDrivingApp(app, recordApp)) return true
  const since = claimedSince ?? Date.now()
  if (!(await restampPidLock(desktopClaimPath(), desktopClaimOwner(), recordOf(app, since)))) {
    await releaseOwnedClaim()
    return false
  }
  recordApp = app
  claimedSince = since
  return true
}

export async function claimDesktop(signal: AbortSignal, app: DesktopDrivingAppInput = null): Promise<DesktopClaimVerdict> {
  if (signal.aborted) return { held: false, holder: null, aborted: true }
  clearIdleTimer()
  const epoch = releaseEpoch
  pendingClaims++
  try {
    return await serializeClaim(async (): Promise<DesktopClaimVerdict> => {
      if (signal.aborted || epoch !== releaseEpoch) return { held: false, holder: null, aborted: true }
      const driving = drivingAppOf(app)
      if (!held) {
        const verdict = await acquire(driving)
        if (!verdict.held) return verdict
      } else if (driving !== null && !(await restamp(driving))) {
        return { held: false, holder: await probeDesktopLock() }
      }
      if (signal.aborted || epoch !== releaseEpoch) {
        await releaseOwnedClaim()
        return { held: false, holder: null, aborted: true }
      }
      armAbortRelease(signal)
      actInFlight = true
      publishDesktopDriving(driving)
      return { held: true }
    })
  } finally {
    pendingClaims--
  }
}

export function renewDesktopClaim(): void {
  actInFlight = false
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
  releaseEpoch++
  clearIdleTimer()
  return serializeClaim(releaseOwnedClaim)
}

export async function releaseDesktopClaimForIdle(): Promise<void> {
  if (!held || pendingClaims > 0 || actInFlight) return
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
  const holder = await probePidLock(desktopClaimPath(), { liveness: 'assume-dead', cachedLiveness: true })
  if (holder === null || holder.owner !== `${conversationIdHere()}:${holder.pid}`) return IDLE_DESKTOP_SNAPSHOT
  const raw = await readFile(desktopClaimPath(), 'utf8').catch(() => null)
  if (raw === null) return IDLE_DESKTOP_SNAPSHOT
  const identity = safeParseJSON(raw, false) as { owner?: unknown; pid?: unknown } | null
  if (identity?.owner !== holder.owner || identity?.pid !== holder.pid) return IDLE_DESKTOP_SNAPSHOT
  const record = recordFromText(raw)
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
let pollGeneration = 0

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
  const generation = pollGeneration
  try {
    const view = await readDesktopClaimFile()
    if (generation === pollGeneration && poll !== null) publishFileView(view)
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
  pollGeneration++
  if (poll !== null) {
    clearInterval(poll)
    poll = null
  }
  publishFileView(IDLE_DESKTOP_SNAPSHOT)
}

export function desktopClaimPollArmed(): boolean {
  return poll !== null
}

subscribeFocusedSessionConnector(() => {
  pollGeneration++
  publishFileView(IDLE_DESKTOP_SNAPSHOT)
  if (poll !== null) void readFileView()
})

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
  void serializeClaim(() => restamp(drivingAppOfSnapshot(view)))
})

registerCleanup(async () => {
  await releaseDesktopClaim()
})
