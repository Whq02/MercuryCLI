
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deleteFlagEnv, flagEnv } from './flagRegistry.js'
import { getMercuryHome } from '../utils/envUtils.js'

const ACTIONS = new Set(['continue', 'doctor', 'project', 'resume', 'concourse', 'kit', 'saturn', 'logins', 'agents', 'cancel'])

let pendingKitManagerDeepLink = false
export function armKitManagerDeepLink(): void {
  pendingKitManagerDeepLink = true
}
export function consumeKitManagerDeepLink(): boolean {
  const armed = pendingKitManagerDeepLink
  pendingKitManagerDeepLink = false
  return armed
}

export type FaceDoorDeepLink = 'health' | 'resume' | 'saturn' | 'logins' | 'agents'
let pendingFaceDoorDeepLink: FaceDoorDeepLink | null = null
export function armFaceDoorDeepLink(door: FaceDoorDeepLink): void {
  pendingFaceDoorDeepLink = door
}
export function peekFaceDoorDeepLink(): FaceDoorDeepLink | null {
  return pendingFaceDoorDeepLink
}
export function consumeFaceDoorDeepLink(): FaceDoorDeepLink | null {
  const v = pendingFaceDoorDeepLink
  pendingFaceDoorDeepLink = null
  return v
}

export type BootSurfaceIntent = 'concourse' | 'repl'
let pendingBootSurfaceIntent: BootSurfaceIntent | null = null

let explicitBootJourney = false
export function markExplicitBootJourney(): void {
  explicitBootJourney = true
}
export function retractExplicitBootJourney(): void {
  explicitBootJourney = false
}
export function bootJourneyIsExplicit(): boolean {
  return explicitBootJourney
}

export function consumeBootSurfaceIntent(): BootSurfaceIntent | null {
  const v = pendingBootSurfaceIntent
  pendingBootSurfaceIntent = null
  return v
}

export function _setBootSurfaceIntentForTesting(v: BootSurfaceIntent | null): void {
  pendingBootSurfaceIntent = v
}

const FRESH_MS = 120_000

export interface SplashReceiptDecision {
  apply: { chdir?: string; spliceArg?: string } | null
  reason:
    | 'applied'
    | 'no-file'
    | 'malformed'
    | 'stale'
    | 'foreign-launch'
    | 'screen-only'
    | 'cancel-ignored'
    | 'unknown-action'
}

export function decideSplashReceipt(
  raw: string | null,
  now: number,
  dirExists: (dir: string) => boolean,
  ownLaunchId: string | null = null,
): SplashReceiptDecision {
  if (raw === null) return { apply: null, reason: 'no-file' }
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return { apply: null, reason: 'malformed' }
  }
  if (
    typeof o !== 'object' ||
    o === null ||
    (o as { version?: unknown }).version !== 1 ||
    typeof (o as { ts?: unknown }).ts !== 'number'
  ) {
    return { apply: null, reason: 'malformed' }
  }
  const receipt = o as { ts: number; action?: unknown; dir?: unknown; launchId?: unknown }
  if (
    typeof receipt.launchId === 'string' &&
    receipt.launchId !== '' &&
    ownLaunchId !== null &&
    receipt.launchId !== ownLaunchId
  ) {
    return { apply: null, reason: 'foreign-launch' }
  }
  if (Math.abs(now - receipt.ts) >= FRESH_MS) return { apply: null, reason: 'stale' }
  if (receipt.action === undefined) {
    return { apply: null, reason: 'screen-only' }
  }
  if (typeof receipt.action !== 'string' || !ACTIONS.has(receipt.action)) {
    return { apply: null, reason: 'unknown-action' }
  }
  if (receipt.action === 'cancel') return { apply: null, reason: 'cancel-ignored' }
  const dir =
    typeof receipt.dir === 'string' && receipt.dir && dirExists(receipt.dir)
      ? receipt.dir
      : undefined
  if (receipt.action === 'concourse') pendingBootSurfaceIntent = 'concourse'
  else if (receipt.action === 'continue') pendingBootSurfaceIntent = 'repl'
  else if (receipt.action === 'doctor') pendingFaceDoorDeepLink = 'health'
  else if (receipt.action === 'resume') pendingFaceDoorDeepLink = 'resume'
  else if (receipt.action === 'saturn') pendingFaceDoorDeepLink = 'saturn'
  else if (receipt.action === 'logins') pendingFaceDoorDeepLink = 'logins'
  else if (receipt.action === 'agents') pendingFaceDoorDeepLink = 'agents'
  else if (receipt.action === 'kit') pendingKitManagerDeepLink = true
  const spliceArg =
    receipt.action === 'continue'
      ? '--continue'
      : undefined
  if (dir === undefined && spliceArg === undefined) {
    return { apply: null, reason: 'applied' }
  }
  return {
    apply: { ...(dir ? { chdir: dir } : {}), ...(spliceArg ? { spliceArg } : {}) },
    reason: 'applied',
  }
}

export function consumeSplashHandover(): void {
  if (flagEnv('MERCURY_SPLASH_HANDOFF') !== '1') return
  deleteFlagEnv('MERCURY_SPLASH_HANDOFF')
  let raw: string | null = null
  let home: string
  try {
    home = getMercuryHome()
  } catch {
    return
  }
  const receiptPath = join(home, 'splash-action.json')
  try {
    raw = readFileSync(receiptPath, 'utf8')
  } catch {
    raw = null
  }
  const ownLaunchId = flagEnv('MERCURY_LAUNCH_ID') || null
  const decision = decideSplashReceipt(raw, Date.now(), dir => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }, ownLaunchId)
  if (decision.reason !== 'foreign-launch') {
    for (const f of [receiptPath, join(home, 'splash-action.txt')]) {
      try {
        rmSync(f, { force: true })
      } catch {
      }
    }
  }
  if (!decision.apply) return
  if (decision.apply.chdir) {
    try {
      process.chdir(decision.apply.chdir)
    } catch {
    }
  }
  if (decision.apply.spliceArg) {
    process.argv.splice(2, 0, decision.apply.spliceArg)
  }
}
