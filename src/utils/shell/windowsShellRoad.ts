import memoize from 'lodash-es/memoize.js'

import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { getPlatform } from '../platform.js'
import { GIT_BASH_REMEDY, locateGitBash, type GitBashLocation } from '../windowsPaths.js'
import type { ShellEngineResolution } from './engineSession.js'
import { shellEngineArmWords, type ShellEngineArm } from './shellEngineArm.js'


export type WindowsBashRoad =
  | { kind: 'git-bash'; path: string }
  | { kind: 'engine'; path: string; arm: ShellEngineArm }
  | { kind: 'absent'; remedy: string }

export type ShellEngineBinary = { path: string; arm: ShellEngineArm } | null

export const WINDOWS_BASH_NOTICE =
  'Bash tool absent — no bash.exe found: install Git for Windows, set MERCURY_GIT_BASH_PATH=<path to bash.exe>, or turn the shell engine on'

export const WINDOWS_BASH_NOTICE_NO_PACK =
  'Bash tool absent — no bash.exe found and the bundled shell engine is unavailable: install Git for Windows, set MERCURY_GIT_BASH_PATH=<path to bash.exe>, or restore the shell engine pack (a release archive carries it; a source build makes it with bun run scripts/vendor/build-brush.ts, then bun run build.ts)'

function roadProbe(): 'no-bash' | 'locate' | null {
  const value = flagEnv('MERCURY_WINDOWS_SHELL_ROAD')
  return value === 'no-bash' || value === 'locate' ? value : null
}

export function windowsShellRoadActive(): boolean {
  return getPlatform() === 'windows' || roadProbe() !== null
}

export function composeWindowsBashRoad(gitBash: GitBashLocation, engine: ShellEngineBinary): WindowsBashRoad {
  if (engine !== null) return { kind: 'engine', path: engine.path, arm: engine.arm }
  if ('path' in gitBash) return { kind: 'git-bash', path: gitBash.path }
  return { kind: 'absent', remedy: GIT_BASH_REMEDY }
}

const locatedWindowsBash = memoize((): GitBashLocation => (roadProbe() === 'no-bash' ? { absent: true } : locateGitBash()))

export function windowsBashAbsent(): boolean {
  return windowsShellRoadActive() && !('path' in locatedWindowsBash())
}

function resolvedShellEngine(): ShellEngineResolution {
  const { resolveShellEngine } = require('./engineSession.js') as typeof import('./engineSession.js')
  const { getInitialSettings } = require('../settings/settings.js') as typeof import('../settings/settings.js')
  return resolveShellEngine(getInitialSettings().shellEngine)
}

function armedShellEngine(): ShellEngineBinary {
  const resolved = resolvedShellEngine()
  return resolved.engine === 'brush' ? { path: resolved.binaryPath, arm: resolved.arm } : null
}

export const windowsBashRoad = memoize((): WindowsBashRoad => composeWindowsBashRoad(locatedWindowsBash(), armedShellEngine()))

export function bashToolAvailable(): boolean {
  return !windowsShellRoadActive() || windowsBashRoad().kind !== 'absent'
}

export function windowsShellRoadNotice(): string | null {
  if (!windowsShellRoadActive()) return null
  return windowsBashRoad().kind === 'absent' ? WINDOWS_BASH_NOTICE : null
}

export function hookBashShell(hookCommand: string): string {
  const road = windowsBashRoad()
  if (road.kind === 'absent') {
    throw new Error(`Hook "${hookCommand}" runs under bash, and no bash is available: ${road.remedy}`)
  }
  return road.path
}

export function describeWindowsShellRoad(): {
  road: 'system' | 'git-bash' | 'engine' | 'absent'
  absent: boolean
  line: string
  fix?: string
} {
  if (!windowsShellRoadActive()) {
    return { road: 'system', absent: false, line: 'the system shell (bash or zsh on PATH) — the Bash tool runs under it' }
  }
  const road = windowsBashRoad()
  if (road.kind === 'git-bash') return { road: 'git-bash', absent: false, line: `git-bash at ${road.path} — found on this machine; the Bash tool runs under it` }
  if (road.kind === 'engine') {
    return {
      road: 'engine',
      absent: false,
      line:
        road.arm === 'no-bash'
          ? `the bundled shell engine at ${road.path} — no bash.exe was found on this machine, so the Bash tool runs under Mercury's own bash-compatible engine`
          : `the shell engine at ${road.path} — the Bash tool runs under it (${shellEngineArmWords(road.arm)}), no Git dependency`,
    }
  }
  const engine = resolvedShellEngine()
  const noPack = engine.engine === 'system' && engine.requested === 'brush'
  const why = engine.engine === 'system' && engine.requested === 'brush' ? engine.reason : `the shell engine is turned off (${shellEngineArmWords(engine.arm)})`
  return {
    road: 'absent',
    absent: true,
    line: `no bash.exe found and ${why} — the Bash tool is absent from the roster; the PowerShell tool is present`,
    fix: noPack ? WINDOWS_BASH_NOTICE_NO_PACK : WINDOWS_BASH_NOTICE,
  }
}

export function armWindowsShellRoad(): void {
  if (!windowsShellRoadActive()) return
  const road = windowsBashRoad()
  if (road.kind === 'git-bash') {
    process.env.SHELL = road.path
    logForDebugging(`windows shell road: SHELL set to ${road.path}`)
    return
  }
  if (road.kind === 'engine') {
    logForDebugging(`windows shell road: the shell engine at ${road.path} (${shellEngineArmWords(road.arm)})`)
    return
  }
  logForDebugging(`windows shell road: ${WINDOWS_BASH_NOTICE}`, { level: 'warn' })
}
