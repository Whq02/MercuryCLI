import { existsSync, mkdirSync, readFileSync, renameSync, watch as watchDir, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

import { flagEnabled } from '../substrate/flagRegistry.js'
import { armInactivityDeadline } from '../async/deadline.js'
import { logForDebugging } from '../logs/debugLog.js'
import { getMercuryHome } from '../environment/envUtils.js'
import { getEssentialTrafficOnlyReason } from '../../models/roads/privacyLevel.js'
import { comparePrivateVersions, parsePrivateVersion } from './channelCore.js'
import { readCurrentVersion, reconcileManagedShims, resolveLayoutRoots, type LayoutRoots } from './installLayout.js'
import { firstProfileHome } from '../profiles/profiles.js'
import { checkForUpdate, type CheckOutcome } from './updateService.js'
import { nixInstallRoot } from './installProvenance.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'
import { startTimeout, stopTimeout } from '../async/timers.js'

export const UPDATE_NOTICE_CACHE_FILE = 'update-notice.json'
export const UPDATE_NOTICE_DAILY_MS = 24 * 60 * 60 * 1000
export const UPDATE_NOTICE_FIRST_DELAY_MS = 8_000
export const UPDATE_NOTICE_CHECK_LIMIT_MS = 20_000
export const UPDATE_NOTICE_STAY_MS = 5 * 60 * 1000
export const UPDATE_NOTICE_KEY = 'update-available'

export interface UpdateNoticeCacheV1 {
  schema: 1
  checkedAtMs: number
  runningVersion: string
  available?: { version: string; tag: string }
  faceAnnounced?: string
}

export type QuietCheckDecision =
  | { action: 'notify-from-cache'; available: { version: string; tag: string } }
  | { action: 'skip'; reason: 'fresh-and-current' }
  | { action: 'check' }

export function decideQuietCheck(
  cache: UpdateNoticeCacheV1 | null,
  nowMs: number,
  runningVersion: string,
  dailyMs: number = UPDATE_NOTICE_DAILY_MS,
  installedVersion: string | null = null,
): QuietCheckDecision {
  if (cache === null || cache.runningVersion !== runningVersion) return { action: 'check' }
  const fresh = nowMs - cache.checkedAtMs >= 0 && nowMs - cache.checkedAtMs < dailyMs
  if (!fresh) return { action: 'check' }
  if (cache.available !== undefined && updateVersionStillAvailable(cache.available.version, runningVersion, installedVersion)) {
    return { action: 'notify-from-cache', available: cache.available }
  }
  return { action: 'skip', reason: 'fresh-and-current' }
}

export function updateNoticeText(version: string): string {
  return `v${version} available — mercury update`
}

export function faceUpdateNoticeText(version: string): string {
  return `v${version} available · mercury update`
}

function newerThanRunning(available: string, runningVersion: string): boolean {
  const a = parsePrivateVersion(available)
  const r = parsePrivateVersion(runningVersion)
  return a !== null && r !== null ? comparePrivateVersions(a, r) > 0 : available !== runningVersion
}

export function updateVersionStillAvailable(
  available: string,
  runningVersion: string,
  installedVersion: string | null = null,
): boolean {
  if (!newerThanRunning(available, runningVersion)) return false
  if (installedVersion !== null && !newerThanRunning(available, installedVersion)) return false
  return true
}

function sharedVersionsDir(roots: LayoutRoots): string {
  if (existsSync(join(roots.versionsDir, 'current.txt'))) return roots.versionsDir
  const shared = join(firstProfileHome(), 'versions')
  return existsSync(join(shared, 'current.txt')) ? shared : roots.versionsDir
}

function installedVersionFor(roots: LayoutRoots): string | null {
  const dir = sharedVersionsDir(roots)
  return readCurrentVersion(dir === roots.versionsDir ? roots : { ...roots, versionsDir: dir })
}

export function decideFaceNotice(
  cache: UpdateNoticeCacheV1 | null,
  runningVersion: string,
  installedVersion: string | null = null,
): string | null {
  if (cache === null || cache.runningVersion !== runningVersion || cache.available === undefined) return null
  const version = cache.available.version
  if (!updateVersionStillAvailable(version, runningVersion, installedVersion) || cache.faceAnnounced === version) return null
  return version
}

export interface FaceNoticeDeps {
  readCache: () => UpdateNoticeCacheV1 | null
  writeCache: (cache: UpdateNoticeCacheV1) => void
  runningVersion: string
  installedVersion?: () => string | null
  enabled: () => boolean
}

export function takeFaceUpdateNotice(
  deps: FaceNoticeDeps = {
    readCache: () => readUpdateNoticeCache(),
    writeCache: cache => writeUpdateNoticeCache(cache),
    runningVersion: MACRO.VERSION,
    installedVersion: () => installedVersionFor(resolveLayoutRoots()),
    enabled: () => flagEnabled('MERCURY_UPDATE_NOTICE'),
  },
): string | null {
  if (!deps.enabled() || nixInstallRoot() !== null) return null
  const cache = deps.readCache()
  const installed = deps.installedVersion ? deps.installedVersion() : null
  const version = decideFaceNotice(cache, deps.runningVersion, installed)
  if (version === null || cache === null) return null
  deps.writeCache({ ...cache, faceAnnounced: version })
  return faceUpdateNoticeText(version)
}

export function updateNoticeCachePath(home: string = getMercuryHome()): string {
  return join(home, UPDATE_NOTICE_CACHE_FILE)
}

export function readUpdateNoticeCache(path: string = updateNoticeCachePath()): UpdateNoticeCacheV1 | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateNoticeCacheV1>
    if (raw.schema !== 1 || typeof raw.checkedAtMs !== 'number' || typeof raw.runningVersion !== 'string') return null
    const available =
      raw.available && typeof raw.available.version === 'string' && typeof raw.available.tag === 'string'
        ? { version: raw.available.version, tag: raw.available.tag }
        : undefined
    const faceAnnounced = typeof raw.faceAnnounced === 'string' ? raw.faceAnnounced : undefined
    return {
      schema: 1,
      checkedAtMs: raw.checkedAtMs,
      runningVersion: raw.runningVersion,
      ...(available ? { available } : {}),
      ...(faceAnnounced ? { faceAnnounced } : {}),
    }
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function writeUpdateNoticeCache(cache: UpdateNoticeCacheV1, path: string = updateNoticeCachePath()): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    logForDebugging(`update notice: cache write failed: ${error}`)
  }
}

export interface QuietCheckDeps {
  check: () => Promise<CheckOutcome>
  readCache: () => UpdateNoticeCacheV1 | null
  writeCache: (cache: UpdateNoticeCacheV1) => void
  notify: (text: string) => void
  now: () => number
  runningVersion: string
  installedVersion?: string | null
  limitMs?: number
}

export type QuietCheckResult = 'notified' | 'notified-from-cache' | 'current' | 'skipped' | 'failed'

export async function runQuietUpdateCheck(deps: QuietCheckDeps): Promise<QuietCheckResult> {
  const cache = deps.readCache()
  const installed = deps.installedVersion ?? null
  const carried = cache?.faceAnnounced ? { faceAnnounced: cache.faceAnnounced } : {}
  const decision = decideQuietCheck(cache, deps.now(), deps.runningVersion, UPDATE_NOTICE_DAILY_MS, installed)
  if (decision.action === 'skip') return 'skipped'
  if (decision.action === 'notify-from-cache') {
    deps.notify(updateNoticeText(decision.available.version))
    return 'notified-from-cache'
  }
  const deadline = armInactivityDeadline({ seam: 'quiet update check', limitMs: deps.limitMs ?? UPDATE_NOTICE_CHECK_LIMIT_MS })
  let outcome: CheckOutcome
  try {
    outcome = await deadline.within(deps.check())
  } catch (error) {
    logForDebugging(`update notice: check failed silently: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  } finally {
    deadline.cancel()
  }
  const checkedAtMs = deps.now()
  if (outcome.state === 'update-available' && updateVersionStillAvailable(outcome.version, deps.runningVersion, installed)) {
    deps.writeCache({ schema: 1, checkedAtMs, runningVersion: deps.runningVersion, available: { version: outcome.version, tag: outcome.tag }, ...carried })
    deps.notify(updateNoticeText(outcome.version))
    return 'notified'
  }
  if (outcome.state === 'update-available' || outcome.state === 'current' || outcome.state === 'no-releases') {
    deps.writeCache({ schema: 1, checkedAtMs, runningVersion: deps.runningVersion, ...carried })
    return 'current'
  }
  logForDebugging(`update notice: check unavailable (${outcome.state}) — silent`)
  return 'failed'
}

export function quietUpdateCheckArmed(env: NodeJS.ProcessEnv = hostEnv()): boolean {
  return flagEnabled('MERCURY_UPDATE_NOTICE') && getEssentialTrafficOnlyReason(env) === null
}

const POINTER_WATCH_COALESCE_MS = 100

export function scheduleQuietUpdateNotice(
  notify: (text: string) => void,
  opts: { delayMs?: number; onDismiss?: () => void } = {},
): () => void {
  if (!quietUpdateCheckArmed() || nixInstallRoot() !== null) return () => {}
  let disposed = false
  let watcher: FSWatcher | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let advertised: string | null = null
  const stopWatch = (): void => {
    if (settleTimer !== null) {
      stopTimeout(settleTimer)
      settleTimer = null
    }
    if (watcher !== null) {
      watcher.close()
      watcher = null
    }
  }
  const checkInstalled = (roots: LayoutRoots): void => {
    if (disposed || advertised === null) return
    if (updateVersionStillAvailable(advertised, MACRO.VERSION, installedVersionFor(roots))) return
    advertised = null
    stopWatch()
    opts.onDismiss?.()
  }
  const armPointerWatch = (roots: LayoutRoots): void => {
    if (disposed || opts.onDismiss === undefined) return
    checkInstalled(roots)
    if (advertised === null) return
    const dir = sharedVersionsDir(roots)
    if (!existsSync(dir)) return
    try {
      watcher = watchDir(dir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && String(name) !== 'current.txt') return
        if (settleTimer !== null) return
        settleTimer = startTimeout(() => {
          settleTimer = null
          checkInstalled(roots)
        }, POINTER_WATCH_COALESCE_MS)
        settleTimer.unref?.()
      })
      watcher.on('error', error => logForDebugging(`update notice: pointer watch failed: ${String(error)}`))
    } catch (error) {
      logForDebugging(`update notice: pointer watch did not arm: ${String(error)}`)
    }
  }
  const timer = startTimeout(() => {
    const roots = resolveLayoutRoots()
    reconcileManagedShims(roots)
    void runQuietUpdateCheck({
      check: () => checkForUpdate(roots, () => {}),
      readCache: () => readUpdateNoticeCache(),
      writeCache: cache => writeUpdateNoticeCache(cache),
      notify: text => {
        if (disposed) return
        advertised = /^v(\S+) available /.exec(text)?.[1] ?? null
        notify(text)
        if (advertised !== null) armPointerWatch(roots)
      },
      now: Date.now,
      runningVersion: MACRO.VERSION,
      installedVersion: installedVersionFor(roots),
    }).catch(error => logForDebugging(`update notice: ${error}`))
  }, opts.delayMs ?? UPDATE_NOTICE_FIRST_DELAY_MS)
  timer.unref?.()
  return () => {
    disposed = true
    stopTimeout(timer)
    stopWatch()
  }
}
