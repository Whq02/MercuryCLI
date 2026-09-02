// ============================================================================
//  src/services/privateChannel/quietUpdateNotice.ts — the quiet update
//  notice (operator-requested under
//  the absolute no-telemetry law).
//
//  WHAT IT SENDS: nothing about you. The check is the SAME release listing
//  `mercury update --check` performs — one read of the channel repository's
//  release list through the collaborator's own signed-in `gh` (the private
//  channel has no anonymous endpoint; the request carries gh's credential
//  and no Mercury identifier, machine fact or usage datum of any kind). On
//  the public channel at publication the same design becomes an anonymous
//  GET of the release manifest.
//
//  WHEN: deferred past first paint (a timer armed at mount), never on the
//  boot path; at most once a day (a small cache in the config home keeps
//  the last answer and its time); silent on every failure (offline, gh
//  missing, not signed in, no access — nothing is said, nothing retried).
//
//  WHAT YOU SEE: one calm line in the existing notice surface —
//  "vX.Y.Z available — mercury update" — that expires on its own and never
//  blocks, nags, or refuses to start. A newer version already cached within
//  the day renders from the cache without a network call. The registered
//  MERCURY_UPDATE_NOTICE flag ('=0') disables the check entirely (law 3).
//  One owner: this extends the private-channel updater — no parallel
//  subsystem.
// ============================================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { flagEnabled } from '../../substrate/flagRegistry.js'
import { armInactivityDeadline } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { resolveLayoutRoots } from './installLayout.js'
import { checkForUpdate, type CheckOutcome } from './updateService.js'

export const UPDATE_NOTICE_CACHE_FILE = 'update-notice.json'
/** At most one listing per day. */
export const UPDATE_NOTICE_DAILY_MS = 24 * 60 * 60 * 1000
/** The first check waits for the boot frames to settle. */
export const UPDATE_NOTICE_FIRST_DELAY_MS = 8_000
/** A hung gh must never matter: the quiet check gives up silently. */
export const UPDATE_NOTICE_CHECK_LIMIT_MS = 20_000
export const UPDATE_NOTICE_KEY = 'update-available'

export interface UpdateNoticeCacheV1 {
  schema: 1
  checkedAtMs: number
  /** The version that ran when the check happened — a different running
   *  version (the update was installed) invalidates the cached answer. */
  runningVersion: string
  available?: { version: string; tag: string }
}

export type QuietCheckDecision =
  | { action: 'notify-from-cache'; available: { version: string; tag: string } }
  | { action: 'skip'; reason: 'fresh-and-current' }
  | { action: 'check' }

/** Pure: what this boot does with the cache. Exported for the prover. */
export function decideQuietCheck(
  cache: UpdateNoticeCacheV1 | null,
  nowMs: number,
  runningVersion: string,
  dailyMs: number = UPDATE_NOTICE_DAILY_MS,
): QuietCheckDecision {
  if (cache === null || cache.runningVersion !== runningVersion) return { action: 'check' }
  const fresh = nowMs - cache.checkedAtMs >= 0 && nowMs - cache.checkedAtMs < dailyMs
  if (!fresh) return { action: 'check' }
  if (cache.available !== undefined && cache.available.version !== runningVersion) {
    return { action: 'notify-from-cache', available: cache.available }
  }
  return { action: 'skip', reason: 'fresh-and-current' }
}

/** The one calm line. Exported for the prover. */
export function updateNoticeText(version: string): string {
  return `v${version} available — mercury update`
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
    return { schema: 1, checkedAtMs: raw.checkedAtMs, runningVersion: raw.runningVersion, ...(available ? { available } : {}) }
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

/**
 * The whole quiet check, dependency-injected so the prover drives it with a
 * scripted listing. Every failure path returns 'failed' and says nothing.
 */
export async function runQuietUpdateCheck(deps: QuietCheckDeps): Promise<QuietCheckResult> {
  const decision = decideQuietCheck(deps.readCache(), deps.now(), deps.runningVersion)
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
  if (outcome.state === 'update-available') {
    deps.writeCache({ schema: 1, checkedAtMs, runningVersion: deps.runningVersion, available: { version: outcome.version, tag: outcome.tag } })
    deps.notify(updateNoticeText(outcome.version))
    return 'notified'
  }
  if (outcome.state === 'current' || outcome.state === 'no-releases') {
    deps.writeCache({ schema: 1, checkedAtMs, runningVersion: deps.runningVersion })
    return 'current'
  }
  // Access, platform, pointer, or release-shape refusals: silent, uncached
  // (the next day's boot asks again).
  logForDebugging(`update notice: check unavailable (${outcome.state}) — silent`)
  return 'failed'
}

/**
 * Arm the quiet check for an interactive session: fires once, after the
 * boot frames, gated by the registered flag. Returns the disarm.
 */
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
