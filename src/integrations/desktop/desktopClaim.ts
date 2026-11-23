import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { getSessionId } from '../../boot/process-state/processState.js'
import { conversationIdHere, subscribeFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { daemonDir } from '../../daemon/control/controlSocket.js'
import {
  acquirePidLock,
  noteLockRelease,
  probePidLock,
  releasePidLock,
  restampPidLock,
  type PidLockHolder,
} from '../../platform/substrate/pidLock.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { safeParseJSON } from '../../platform/storage/json.js'
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
import { subscribeUiClock } from '../../screen/cockpit/uiClock.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { resolveWatchRoot } from '../../platform/processes/watchRoot.js'

export const DESKTOP_CLAIM_FILE = 'desktop.lock'
export const DESKTOP_CLAIM_IDLE_RELEASE_MS = 30_000
const DESKTOP_CLAIM_POLL_MS = 500

export function desktopClaimPath(): string {
  return join(daemonDir(), DESKTOP_CLAIM_FILE)
}

function sessionWord(): string {
  try {
    return String(getSessionId())
  } catch (error) {
    passedOver(error)
    return 'boot'
  }
}

let owner: string | null = null

function desktopClaimOwner(): string {
  if (owner === null) owner = `${sessionWord()}:${process.pid}`
  return owner
}

type DesktopClaimVerdict =
  | { held: true }
  | { held: false; holder: PidLockHolder | null; aborted?: true }

type DesktopClaimRecord = {
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
    stopTimeout(idleTimer)
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
  mutation = result.then(() => undefined, passedOverAs(undefined))
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
  await mkdir(daemonDir(), { recursive: true }).catch(passedOverAs(undefined))
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
  idleTimer = startTimeout(() => {
    void releaseDesktopClaimForIdle()
  }, DESKTOP_CLAIM_IDLE_RELEASE_MS)
  idleTimer.unref?.()
}

export function desktopClaimHeld(): boolean {
  return held
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

export async function readDesktopClaimFile(): Promise<DesktopSnapshot> {
  const holder = await probePidLock(desktopClaimPath(), { liveness: 'assume-dead', cachedLiveness: true })
  if (holder === null || holder.owner !== `${conversationIdHere()}:${holder.pid}`) return IDLE_DESKTOP_SNAPSHOT
  let raw: string
  try {
    raw = await readFile(desktopClaimPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      passedOver(error)
      return IDLE_DESKTOP_SNAPSHOT
    }
    throw error
  }
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
let poll: (() => void) | null = null
let reading = 0
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
  if (reading > 0) {
    reading = 2
    return
  }
  reading = 1
  try {
    for (;;) {
      const generation = pollGeneration
      try {
        const view = await readDesktopClaimFile()
        if (generation === pollGeneration && poll !== null) publishFileView(view)
      } catch (error) {
        logForDebugging(`desktop claim: the file view read failed — ${error instanceof Error ? error.message : String(error)}`)
      }
      if (reading < 2 || poll === null) break
      reading = 1
    }
  } finally {
    reading = 0
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

function nearestExistingDir(dir: string): string {
  let target = dir
  while (target !== dirname(target) && !existsSync(target)) target = dirname(target)
  return target
}

function watchDesktopClaimFile(): () => void {
  const dir = daemonDir()
  let watcher: FSWatcher | null = null
  let stopFallback: (() => void) | null = null
  let closed = false

  const closeWatcher = (): void => {
    if (watcher === null) return
    const active = watcher
    watcher = null
    try {
      active.close()
    } catch (error) {
      passedOver(error)
    }
  }

  const startFallback = (): void => {
    if (closed || stopFallback !== null) return
    stopFallback = subscribeUiClock(DESKTOP_CLAIM_POLL_MS, () => {
      void readFileView()
    })
  }

  const armWatch = (): void => {
    if (closed) return
    closeWatcher()
    const target = nearestExistingDir(dir)
    const watchingDir = target === dir
    const nextChild = watchingDir ? null : relative(target, dir).split(sep)[0] ?? null
    try {
      const next = watch(resolveWatchRoot(target), { persistent: false }, (_event, filename) => {
        if (closed) return
        if (!watchingDir) {
          if (filename !== null && nextChild !== null && String(filename) !== nextChild) return
          const deeper = nearestExistingDir(dir)
          if (deeper !== target) {
            armWatch()
            if (deeper === dir) void readFileView()
          }
          return
        }
        if (filename !== null && filename !== DESKTOP_CLAIM_FILE) return
        void readFileView()
      })
      next.on('error', error => {
        passedOver(error)
        if (watcher === next) closeWatcher()
        startFallback()
      })
      watcher = next
      if (!watchingDir && nearestExistingDir(dir).length > target.length) {
        armWatch()
        if (existsSync(dir)) void readFileView()
      }
    } catch (error) {
      passedOver(error)
      startFallback()
    }
  }

  armWatch()
  startFallback()
  return () => {
    closed = true
    closeWatcher()
    if (stopFallback !== null) {
      stopFallback()
      stopFallback = null
    }
  }
}

export function armDesktopClaimPoll(active: boolean): void {
  if (active) {
    if (poll !== null) return
    poll = watchDesktopClaimFile()
    void readFileView()
    return
  }
  pollGeneration++
  if (poll !== null) {
    poll()
    poll = null
  }
  publishFileView(IDLE_DESKTOP_SNAPSHOT)
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


subscribeDesktop(() => {
  if (!held) return
  const view = desktopSnapshot()
  if (view.phase !== 'driving') return
  void serializeClaim(() => restamp(drivingAppOfSnapshot(view)))
})

registerCleanup(async () => {
  await releaseDesktopClaim()
})
