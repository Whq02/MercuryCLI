
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'
import { runningBundlePayloadDir } from '../services/privateChannel/vendoredRuntime.js'

export const SPLASH_EXIT = {
  HANDOFF_HELD: 0,
  HANDOFF_RESTORED: 20,
  CANCEL: 130,
} as const

export const SPLASH_ABNORMAL_HEAL = '\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07'

export const SPLASH_DRIVER = 'splash.mjs'
export const SPLASH_CORE = 'splash-core.mjs'

export type DirectSplashSkip =
  | 'argv'
  | 'not-a-tty'
  | 'launcher-handed-over'
  | 'splash-off'
  | 'splash-static'
  | 'no-banner'
  | 'asset-absent'

export interface DirectSplashFacts {
  args: readonly string[]
  stdinTTY: boolean
  stdoutTTY: boolean
  env: Readonly<Record<string, string | undefined>>
}

export type DirectSplashDecision = { run: true } | { run: false; reason: DirectSplashSkip }

export function decideDirectSplash(f: DirectSplashFacts): DirectSplashDecision {
  if (f.args.length > 0) return { run: false, reason: 'argv' }
  if (!f.stdinTTY || !f.stdoutTTY) return { run: false, reason: 'not-a-tty' }
  if (f.env.MERCURY_SPLASH_HANDOFF !== undefined || f.env.MERCURY_ALT_HELD !== undefined) {
    return { run: false, reason: 'launcher-handed-over' }
  }
  if (f.env.MERCURY_SPLASH === 'off') return { run: false, reason: 'splash-off' }
  if (f.env.MERCURY_SPLASH === 'static') return { run: false, reason: 'splash-static' }
  if (f.env.MERCURY_NO_BANNER === '1') return { run: false, reason: 'no-banner' }
  return { run: true }
}

export type SplashAssetRung = 'payload' | 'home' | 'source'

export interface SplashAssetHit {
  driver: string
  rung: SplashAssetRung
}

export function resolveSplashAsset(f: {
  bundleDir: string | null
  home: string | null
  exists?: (path: string) => boolean
}): SplashAssetHit | null {
  const exists = f.exists ?? existsSync
  const rungs: Array<{ rung: SplashAssetRung; driver: string; core: string } | null> = [
    f.bundleDir
      ? { rung: 'payload', driver: join(f.bundleDir, SPLASH_DRIVER), core: join(f.bundleDir, SPLASH_CORE) }
      : null,
    f.home ? { rung: 'home', driver: join(f.home, SPLASH_DRIVER), core: join(f.home, SPLASH_CORE) } : null,
    f.bundleDir
      ? {
          rung: 'source',
          driver: join(f.bundleDir, '..', 'assets', 'splash', 'mercury-splash.mjs'),
          core: join(f.bundleDir, '..', 'assets', 'splash', SPLASH_CORE),
        }
      : null,
  ]
  for (const candidate of rungs) {
    if (candidate === null) continue
    if (exists(candidate.driver) && exists(candidate.core)) {
      return { driver: candidate.driver, rung: candidate.rung }
    }
  }
  return null
}

export type SplashHandoverVerdict = 'boot' | 'cancel'

export function applySplashExit(
  code: number | null,
  env: Record<string, string | undefined>,
  write: (bytes: string) => void,
): SplashHandoverVerdict {
  if (code === SPLASH_EXIT.CANCEL) return 'cancel'
  if (code === SPLASH_EXIT.HANDOFF_HELD || code === SPLASH_EXIT.HANDOFF_RESTORED) {
    env.MERCURY_SPLASH_HANDOFF = '1'
  } else {
    write(SPLASH_ABNORMAL_HEAL)
  }
  if (code === SPLASH_EXIT.HANDOFF_HELD && env.MERCURY_FULLSCREEN !== '0') {
    env.MERCURY_ALT_HELD = '1'
  }
  return 'boot'
}

export function shellExitCodeOf(r: { status: number | null; signal: NodeJS.Signals | null; error?: Error }): number {
  if (r.error) return 127
  if (r.status !== null) return r.status
  if (r.signal !== null) {
    const n = (osConstants.signals as Record<string, number | undefined>)[r.signal]
    if (typeof n === 'number') return 128 + n
  }
  return 127
}

export type DirectSplashRun =
  | { verdict: 'skipped'; reason: DirectSplashSkip }
  | { verdict: SplashHandoverVerdict; asset: SplashAssetHit; exitCode: number }

export function runDirectSplash(opts: { home: string | null }): DirectSplashRun {
  const decision = decideDirectSplash({
    args: process.argv.slice(2),
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  })
  if (!decision.run) return { verdict: 'skipped', reason: decision.reason }
  const asset = resolveSplashAsset({ bundleDir: runningBundlePayloadDir(), home: opts.home })
  if (asset === null) return { verdict: 'skipped', reason: 'asset-absent' }
  if (!process.env.MERCURY_LAUNCH_ID) {
    process.env.MERCURY_LAUNCH_ID = `direct-${process.pid}-${Date.now()}`
  }
  const outlive = (): void => {}
  process.on('SIGINT', outlive)
  let exitCode: number
  try {
    const r = spawnSync(process.execPath, [asset.driver], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    })
    exitCode = shellExitCodeOf(r)
  } finally {
    process.removeListener('SIGINT', outlive)
  }
  const verdict = applySplashExit(exitCode, process.env, bytes => {
    try {
      process.stdout.write(bytes)
    } catch {
    }
  })
  return { verdict, asset, exitCode }
}
