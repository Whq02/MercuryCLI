import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type CaptureDriver =
  | { kind: 'posix-pty'; python: string; tempRoot: string; engine: 'scripts/ui/vshot.py' }
  | { kind: 'windows-conpty'; python: string; tempRoot: string; engine: 'scripts/winreg' }
  | { kind: 'unavailable'; reason: string; remedy: string }

export type AvailableCaptureDriver = Exclude<CaptureDriver, { kind: 'unavailable' }>

export const CAPTURE_ENGINE_ENTRY = {
  'posix-pty': 'scripts/ui/vshot.py',
  'windows-conpty': 'scripts/winreg/vshot-win.py',
} as const

export function captureEngineEntry(driver: AvailableCaptureDriver, repoRoot: string): string {
  return join(repoRoot, ...CAPTURE_ENGINE_ENTRY[driver.kind].split('/'))
}

export function resolveCaptureArgv0(
  name: string,
  driver: AvailableCaptureDriver,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (driver.kind !== 'windows-conpty') return name
  return findOnPath(name, env, 'win32') ?? name
}

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

export function vshotBudgetScale(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MERCURY_VSHOT_BUDGET_SCALE ?? '1')
  return Number.isFinite(n) && n > 0 ? n : 1
}

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
