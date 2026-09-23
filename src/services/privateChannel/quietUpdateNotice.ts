import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { flagEnabled } from '../../substrate/flagRegistry.js'
import { armInactivityDeadline } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { comparePrivateVersions, parsePrivateVersion } from './channelCore.js'
import { resolveLayoutRoots } from './installLayout.js'
import { checkForUpdate, type CheckOutcome } from './updateService.js'

export const UPDATE_NOTICE_CACHE_FILE = 'update-notice.json'
export const UPDATE_NOTICE_DAILY_MS = 24 * 60 * 60 * 1000
export const UPDATE_NOTICE_FIRST_DELAY_MS = 8_000
export const UPDATE_NOTICE_CHECK_LIMIT_MS = 20_000
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
): QuietCheckDecision {
  if (cache === null || cache.runningVersion !== runningVersion) return { action: 'check' }
  const fresh = nowMs - cache.checkedAtMs >= 0 && nowMs - cache.checkedAtMs < dailyMs
  if (!fresh) return { action: 'check' }
  if (cache.available !== undefined && newerThanRunning(cache.available.version, runningVersion)) {
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

export function decideFaceNotice(cache: UpdateNoticeCacheV1 | null, runningVersion: string): string | null {
  if (cache === null || cache.runningVersion !== runningVersion || cache.available === undefined) return null
  const version = cache.available.version
  if (!newerThanRunning(version, runningVersion) || cache.faceAnnounced === version) return null
  return version
}

export interface FaceNoticeDeps {
  readCache: () => UpdateNoticeCacheV1 | null
  writeCache: (cache: UpdateNoticeCacheV1) => void
  runningVersion: string
  enabled: () => boolean
}

export function takeFaceUpdateNotice(
  deps: FaceNoticeDeps = {
    readCache: () => readUpdateNoticeCache(),
    writeCache: cache => writeUpdateNoticeCache(cache),
    runningVersion: MACRO.VERSION,
    enabled: () => flagEnabled('MERCURY_UPDATE_NOTICE'),
  },
): string | null {
  if (!deps.enabled()) return null
  const cache = deps.readCache()
  const version = decideFaceNotice(cache, deps.runningVersion)
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
  } catch {
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
  limitMs?: number
}

export type QuietCheckResult = 'notified' | 'notified-from-cache' | 'current' | 'skipped' | 'failed'

export async function runQuietUpdateCheck(deps: QuietCheckDeps): Promise<QuietCheckResult> {
  const cache = deps.readCache()
  const carried = cache?.faceAnnounced ? { faceAnnounced: cache.faceAnnounced } : {}
  const decision = decideQuietCheck(cache, deps.now(), deps.runningVersion)
  if (decision.action === 'skip') return 'skipped'
  if (decision.action === 'notify-from-cache') {
    deps.notify(updateNoticeText(decision.available.version))
    return 'notified-from-cache'
  }
  const deadline = armInactivityDeadline({ seam: 'quiet update check', limitMs: deps.limitMs ?? UPDATE_NOTICE_CHECK_LIMIT_MS })
  let outcome: CheckOutcome
  try {
    outcome = await Promise.race([deps.check(), deadline.expiry])
  } catch (error) {
    logForDebugging(`update notice: check failed silently: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  } finally {
    deadline.cancel()
  }
  const checkedAtMs = deps.now()
  if (outcome.state === 'update-available' && newerThanRunning(outcome.version, deps.runningVersion)) {
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

export function scheduleQuietUpdateNotice(notify: (text: string) => void, opts: { delayMs?: number } = {}): () => void {
  if (!flagEnabled('MERCURY_UPDATE_NOTICE')) return () => {}
  const timer = setTimeout(() => {
    void runQuietUpdateCheck({
      check: () => checkForUpdate(resolveLayoutRoots(), () => {}),
      readCache: () => readUpdateNoticeCache(),
      writeCache: cache => writeUpdateNoticeCache(cache),
      notify,
      now: Date.now,
      runningVersion: MACRO.VERSION,
    }).catch(error => logForDebugging(`update notice: ${error}`))
  }, opts.delayMs ?? UPDATE_NOTICE_FIRST_DELAY_MS)
  timer.unref?.()
  return () => clearTimeout(timer)
}
