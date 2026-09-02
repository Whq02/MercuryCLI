// ============================================================================
//  scripts/lib/captureDriver.ts — ONE capture-driver contract.
//
//  Terminal-capture engines are platform machinery: the POSIX PTY engine
//  (scripts/ui/vshot.py — pty/fcntl/termios) and the Windows ConPTY engine
//  (scripts/winreg/*-win.py — pywinpty) are SPECIALIZED drivers; neither runs
//  on the other platform, and pretending otherwise produced the F3 field
//  guidance ("install python3" on a host where POSIX-only modules were the
//  actual blocker). This resolver owns the selection: driver, interpreter,
//  and temp root — the capture entrypoints consume it, they never hard-code
//  an incompatible interpreter again.
//
//  Interpreter law: the registered MERCURY_PYTHON pin wins; otherwise the
//  POSIX arm keeps the macOS system python (/usr/bin/python3 — the pyexpat
//  healthy-fallback the capture stack standardized on), and the Windows arm
//  probes PATH with PATHEXT semantics (python.exe / python3.exe).
//
//  Temp-root law: the POSIX arm returns EXACTLY '/tmp' — the render-tui
//  fixed-path defaults are a PINNED expectation of the concurrent pty-lane
//  byte-identity provers (in-file note there); changing that root is a
//  contract change for those suites, so it is written HERE, once.
// ============================================================================
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type CaptureDriver =
  | { kind: 'posix-pty'; python: string; tempRoot: string; engine: 'scripts/ui/vshot.py' }
  | { kind: 'windows-conpty'; python: string; tempRoot: string; engine: 'scripts/winreg' }
  | { kind: 'unavailable'; reason: string; remedy: string }

export type AvailableCaptureDriver = Exclude<CaptureDriver, { kind: 'unavailable' }>

/**
 * THE SELECTION TABLE: the engine script per driver kind, repo-relative.
 * Both engines read the same cfg grammar and emit the same grid payload
 * (scripts/winreg/prove-capture-grammar.ts pins the parity), so a capture
 * entrypoint spawns `driver.python [entry, cfgPath]` through this table and
 * never names an engine file itself.
 */
export const CAPTURE_ENGINE_ENTRY = {
  'posix-pty': 'scripts/ui/vshot.py',
  'windows-conpty': 'scripts/winreg/vshot-win.py',
} as const

/** The absolute path of the driver's engine script under `repoRoot`. */
export function captureEngineEntry(driver: AvailableCaptureDriver, repoRoot: string): string {
  return join(repoRoot, ...CAPTURE_ENGINE_ENTRY[driver.kind].split('/'))
}

/**
 * argv[0] for a capture: the ConPTY backend hands appname to CreateProcess
 * and CONCATENATES it with the args (vshot-win.py's spawn note) — it never
 * searches PATH — so the Windows arm resolves a bare executable name to its
 * PATHEXT hit; the POSIX arm keeps the name as given (the PTY engine's exec
 * does its own PATH search).
 */
export function resolveCaptureArgv0(
  name: string,
  driver: AvailableCaptureDriver,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (driver.kind !== 'windows-conpty') return name
  return findOnPath(name, env, 'win32') ?? name
}

/** PATHEXT-aware executable probe (the Windows arm's lookup law). */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
      if (ext !== ext.toLowerCase()) {
        const upper = join(dir, name + ext)
        if (existsSync(upper)) return upper
      }
    }
  }
  return null
}

/**
 * THE HOSTED CAPTURE PROFILE's one multiplier (MERCURY_VSHOT_BUDGET_SCALE,
 * default 1 — authored budgets are the local law). The PTY engines stretch
 * their own tick timelines by it; every WRAPPER WALL around a capture spawn
 * must ride the SAME knob, or the wall kills the capture it granted headroom
 * to — gate run 2's unattributable class: spawnSync ETIMEDOUT ⇒ status null,
 * empty stderr, no frame dump (boot-mcp §I1b-I3, workflows-board @80,
 * visual-finish "vshot TIMEOUT (60s)"). Registry: src/substrate/flagRegistry.ts.
 */
export function vshotBudgetScale(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MERCURY_VSHOT_BUDGET_SCALE ?? '1')
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** An authored capture budget in ms, stretched only under the hosted profile. */
export function vshotBudgetMs(baseMs: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(baseMs * vshotBudgetScale(env))
}

export function resolveCaptureDriver(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): CaptureDriver {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const pin = (env.MERCURY_PYTHON ?? env.MERCURY_PYTHON ?? '').trim()
  if (platform === 'win32') {
    const python =
      (pin !== '' ? pin : null) ?? findOnPath('python', env, platform) ?? findOnPath('python3', env, platform)
    if (python === null) {
      return {
        kind: 'unavailable',
        reason: 'no Windows python found on PATH (PATHEXT probe: python/python3)',
        remedy:
          'install Python 3 or pin one (MERCURY_PYTHON=<path>); local capture then uses the ConPTY engine (scripts/winreg, maintainer-pinned pywinpty) — or use the hosted windows-ui workflow',
      }
    }
    return { kind: 'windows-conpty', python, tempRoot: env.RUNNER_TEMP ?? env.TEMP ?? env.TMP ?? '.', engine: 'scripts/winreg' }
  }
  const python = pin !== '' ? pin : '/usr/bin/python3'
  if (!existsSync(python)) {
    return {
      kind: 'unavailable',
      reason: `interpreter ${python} not found`,
      remedy: 'install Python 3 or pin one (MERCURY_PYTHON=<path>)',
    }
  }
  return { kind: 'posix-pty', python, tempRoot: '/tmp', engine: 'scripts/ui/vshot.py' }
}
