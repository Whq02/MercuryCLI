// ============================================================================
//  substrate/directSplash — the launch splash on a DIRECT runtime start.
//
//  A release install's `mercury` launcher paints the enter screen before the
//  runtime: it runs the splash asset as its own process, branches on the
//  asset's EXIT CODE alone (0 handoff+HELD · 20 handoff+RESTORED · 130
//  cancel · else abnormal) and hands over through two env markers —
//  MERCURY_SPLASH_HANDOFF for the receipt consumer (splashHandover) and
//  MERCURY_ALT_HELD for the alt-screen takeover (ink/launcherAltHold). A
//  direct `node mercury.mjs` start has no launcher in front of it, so it
//  booted plain on every platform. THIS module is the launcher's in-process
//  twin for that road: the same takeover gate, the same asset, the same
//  exit-code table applied to this process's env — the runtime then boots
//  exactly as if a launcher had handed over, and every consumer downstream
//  runs unchanged. ONE protocol, two hosts: the table below is pinned
//  byte-for-byte against the launcher's managed action block
//  (assets/splash/launcher-action-block.sh), so the two can never drift.
//
//  THE FLOOR LAW holds here too: a missing asset, a partial pair, a spawn
//  failure or an abnormal splash death may cost the splash, never the boot.
//
//  Import-light on purpose: the cli entry calls this on the bare interactive
//  line only, before anything else has loaded — node builtins plus the one
//  bundle-sibling resolver.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'
import { runningBundlePayloadDir } from '../services/privateChannel/vendoredRuntime.js'

/** The splash's exit codes — the one launcher-facing channel. */
export const SPLASH_EXIT = {
  /** handoff, the alternate screen HELD for the runtime to take over */
  HANDOFF_HELD: 0,
  /** handoff, the screen RESTORED (inline mode — no hold to take over) */
  HANDOFF_RESTORED: 20,
  /** Ctrl-C / SIGTERM / the idle timeout: the BOOT is cancelled */
  CANCEL: 130,
} as const

/** The abnormal-death heal the launcher's action block writes before
 *  booting plain: SGR reset, alternate-scroll off, the alt screen closed,
 *  the cursor shown, the terminal's own ground restored. Bounded and
 *  idempotent — safe on a screen the splash never touched. */
export const SPLASH_ABNORMAL_HEAL = '\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07'

/** The asset pair as it ships beside the bundle and in a deployed home: the
 *  driver imports './splash-core.mjs' beside itself, so a rung answers only
 *  when BOTH files are present (a partial pair would die on import). */
export const SPLASH_DRIVER = 'splash.mjs'
export const SPLASH_CORE = 'splash-core.mjs'

export type DirectSplashSkip =
  /** anything on the line — a verb, a flag, a prompt — is an explicit journey */
  | 'argv'
  /** stdin or stdout is not a terminal (a pipe, a redirect, a script) */
  | 'not-a-tty'
  /** a launcher already ran the splash for this boot and armed its markers */
  | 'launcher-handed-over'
  | 'splash-off'
  | 'splash-static'
  | 'no-banner'
  /** no rung carries the pair — a source build without the asset boots plain */
  | 'asset-absent'

export interface DirectSplashFacts {
  /** the operator's argv after the bundle path (process.argv.slice(2)) */
  args: readonly string[]
  stdinTTY: boolean
  stdoutTTY: boolean
  env: Readonly<Record<string, string | undefined>>
}

export type DirectSplashDecision = { run: true } | { run: false; reason: DirectSplashSkip }

/**
 * The takeover gate — pure over the facts. The launchers' skip laws, with the
 * direct road's one difference spelled out: ANY argument boots straight
 * (verbs, flags and a positional prompt are all explicit journeys — the
 * enter screen is for the bare line alone), and a boot a launcher already
 * splashed (its markers armed) is never splashed twice.
 */
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
  /** the driver's absolute path — the file the runtime spawns */
  driver: string
  rung: SplashAssetRung
}

/**
 * Where the asset lives, first rung answering: beside the running bundle
 * (a release payload, or a source build — the ordinary build copies the
 * pair there), then the config home (a deployed home), then the repository's
 * canonical source relative to the bundle's tree. A source run with no
 * bundle has no rung: the splash is a bundle-road feature.
 */
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

/**
 * THE EXIT-CODE TABLE, applied to an env the way the launcher's action block
 * applies it to the shell's — the block's four cases in the block's order:
 *   130          ⇒ cancel: the splash restored the screen — stand down
 *   0 or 20      ⇒ handoff: arm MERCURY_SPLASH_HANDOFF=1 for the consumer
 *   anything else⇒ abnormal: the bounded heal, then boot plain (no marker)
 *   0, and MERCURY_FULLSCREEN is not '0' ⇒ the screen is HELD: arm
 *                  MERCURY_ALT_HELD=1 for the takeover
 * The code is the shell's reading of the exit (shellExitCodeOf): a death by
 * signal is 128+n, a spawn that never ran is 127 — both land in the
 * abnormal arm unless the number is one the block names. `null` stands for
 * "no reading at all" and is abnormal too.
 */
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

/**
 * The exit code AS A SHELL WOULD REPORT IT (`$?`), so the table above reads
 * the same number the launcher block reads: a normal exit passes through, a
 * death by signal is 128 + the signal number (a splash killed by SIGINT is
 * 130 — a cancel, exactly as under the launcher), and a spawn that never
 * ran is 127 (the shell's command-not-found, abnormal either way).
 */
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

/**
 * The road itself: decide, resolve, run the asset as its own process on this
 * terminal, apply the table to this process's env. `home` is the config home
 * the caller already resolved (the cli entry's inline resolver — this module
 * imports no config machinery).
 */
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
  // The per-launch id every launcher mints before its splash — env-down
  // only, never parsed back: the splash embeds it in its receipt and the
  // consumer applies only a matching one, so two direct starts sharing a
  // config home can never consume each other's enter-screen choice.
  if (!process.env.MERCURY_LAUNCH_ID) {
    process.env.MERCURY_LAUNCH_ID = `direct-${process.pid}-${Date.now()}`
  }
  // The terminal's Ctrl-C reaches this process too (one foreground group);
  // the splash owns the cancel and reports it as exit 130, so this process
  // must outlive the keystroke to apply that verdict — a shell launcher
  // waits through it the same way.
  const outlive = (): void => {}
  process.on('SIGINT', outlive)
  let exitCode: number
  try {
    // The asset IS the screen for as long as it runs: it inherits this
    // terminal outright (no pipes, no shell, never hidden on Windows).
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
      /* the stream is gone — nothing left to heal */
    }
  })
  return { verdict, asset, exitCode }
}
