import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from '../logs/debugLog.js'
import { getPlatform } from '../environment/platform.js'
import { subprocessEnv } from '../processes/subprocessEnv.js'
import { resolveExecutable } from '../processes/which.js'
import { GIT_BASH_REMEDY, installedGitBashes, locateGitBash, pinnedGitBash, type GitBashLocation } from '../files/windowsPaths.js'
import type { ShellEngineResolution } from './engineSession.js'
import { shellEngineArmWords, type ShellEngineArm } from './shellEngineArm.js'
import type { ShellOrigin, ShellRecord } from './shellRecord.js'
import { hostEnv } from '../environment/hostEnv.js'
import { hasRequiredProgramExtension, pathDelimiter } from '../host-os/programs.js'
import { envVarKey } from '../host-os/spawn.js'


export type ShippedBash = { path: string; programsDir: string | null }

export type RoadEngineArm = ShellEngineArm | 'fallback'

export type WindowsBashRoad =
  | { kind: 'git-bash'; path: string }
  | { kind: 'shipped'; path: string }
  | { kind: 'engine'; path: string; arm: RoadEngineArm }
  | { kind: 'absent'; remedy: string }

export type ShellEngineBinary = { path: string; arm: ShellEngineArm } | null

export const WINDOWS_BASH_NOTICE =
  'Bash tool absent — no bash.exe found: install Git for Windows, set MERCURY_GIT_BASH_PATH=<path to bash.exe>, or turn the shell engine on'

export const WINDOWS_BASH_NOTICE_NO_PACK =
  'Bash tool absent — no bash.exe found and the bundled shell engine is unavailable: install Git for Windows, set MERCURY_GIT_BASH_PATH=<path to bash.exe>, or restore the bash pack or the shell engine pack (a release archive carries both; a source build makes them with bun run scripts/vendor/fetch-bash-win.ts and bun run scripts/vendor/build-brush.ts, then bun run build.ts)'

export const NO_SHELL_WAYS_OUT = 'Install Git for Windows, set MERCURY_GIT_BASH_PATH to a bash.exe, or reinstall Mercury; then restart Mercury.'

export const PIN_WAYS_OUT = 'Name a bash.exe in MERCURY_GIT_BASH_PATH or unset it, then restart Mercury.'

const pinWords = (path: string): string => `${path}, named by MERCURY_GIT_BASH_PATH`

function roadProbe(): 'no-bash' | 'pack' | 'locate' | null {
  const value = flagEnv('MERCURY_WINDOWS_SHELL_ROAD')
  return value === 'no-bash' || value === 'pack' || value === 'locate' ? value : null
}

export function windowsShellRoadActive(): boolean {
  return getPlatform() === 'windows' || roadProbe() !== null
}

export function composeWindowsBashRoad(gitBash: GitBashLocation, shipped: ShippedBash | null, engine: ShellEngineBinary): WindowsBashRoad {
  if (engine !== null && engine.arm !== 'no-bash') return { kind: 'engine', path: engine.path, arm: engine.arm }
  if ('path' in gitBash) return { kind: 'git-bash', path: gitBash.path }
  if (shipped !== null) return { kind: 'shipped', path: shipped.path }
  if (engine !== null) return { kind: 'engine', path: engine.path, arm: engine.arm }
  return { kind: 'absent', remedy: GIT_BASH_REMEDY }
}

const installedBashHidden = (): boolean => roadProbe() === 'no-bash' || roadProbe() === 'pack'

const locatedWindowsBash = memoize((): GitBashLocation => (installedBashHidden() ? { absent: true } : locateGitBash()))

function shellRecordDoor(): typeof import('./shellRecord.js') {
  return require('./shellRecord.js') as typeof import('./shellRecord.js')
}

export const shippedWindowsBash = memoize((): ShippedBash | null => (roadProbe() === 'no-bash' ? null : shellRecordDoor().shippedBashOnDisk()))

export function windowsBashAbsent(): boolean {
  return windowsShellRoadActive() && !('path' in locatedWindowsBash()) && shippedWindowsBash() === null
}

export const BASH_COMPANION_PROGRAMS = ['grep', 'head', 'cat', 'sed', 'tail', 'ls', 'cut', 'find', 'wc', 'bash', 'env', 'rm', 'date'] as const

export const OLDEST_BASH_THAT_COUNTS = 5

const POSIX_RUNTIME_FILE = 'msys-2.0.dll'

export type BashCandidate = { path: string; runtimeBeside: boolean; programsMissing: string[] }

export type WindowsShellWorld = {
  pinned: string | null
  installed: () => BashCandidate[]
  shipped: () => { path: string } | { absent: string }
  engine: () => { path: string; version: string } | { absent: string }
  engineAllowed: boolean
  start: (path: string) => Promise<string | null>
  why?: (path: string) => string | undefined
  unfit?: (path: string) => string | undefined
  passed?: string[]
}

export type WindowsShellChoice = { origin: ShellOrigin | 'none'; path: string; version: string; pinned: boolean; passed: string[] }

export async function settleWindowsShell(world: WindowsShellWorld): Promise<WindowsShellChoice> {
  const passed: string[] = world.passed ?? []
  if (world.pinned !== null) {
    const version = await world.start(world.pinned)
    if (version !== null) return { origin: 'system', path: world.pinned, version, pinned: true, passed }
    const unfit = world.unfit?.(world.pinned)
    const why = world.why?.(world.pinned)
    passed.push(unfit !== undefined ? `${pinWords(world.pinned)}: ${unfit}` : `${pinWords(world.pinned)}, did not answer as a bash${why === undefined ? '' : `: ${why}`}`)
  }
  for (const candidate of world.installed()) {
    if (!candidate.runtimeBeside) {
      passed.push(`${candidate.path} is not a bash of the MSYS2 family: its installation holds no ${POSIX_RUNTIME_FILE}`)
      continue
    }
    if (candidate.programsMissing.length > 0) {
      passed.push(`${candidate.path} has no ${candidate.programsMissing.join(', ')} beside it`)
      continue
    }
    const version = await world.start(candidate.path)
    if (version === null) {
      const unfit = world.unfit?.(candidate.path)
      passed.push(unfit !== undefined ? `${candidate.path}: ${unfit}` : `${candidate.path} does not start`)
      continue
    }
    if (!(Number(/^\d+/.exec(version)?.[0]) >= OLDEST_BASH_THAT_COUNTS)) {
      passed.push(`${candidate.path} is bash ${version}, older than ${OLDEST_BASH_THAT_COUNTS}`)
      continue
    }
    return { origin: 'system', path: candidate.path, version, pinned: false, passed }
  }
  const shipped = world.shipped()
  if ('path' in shipped) {
    const version = await world.start(shipped.path)
    if (version !== null) return { origin: 'shipped', path: shipped.path, version, pinned: false, passed }
    passed.push(`the bash Mercury ships, ${shipped.path}, does not start`)
  } else {
    passed.push(`this install carries no bash of its own: ${shipped.absent}`)
  }
  if (!world.engineAllowed) {
    passed.push('the bundled engine is turned off (MERCURY_SHELL_ENGINE=system, or the Shell engine setting)')
    return { origin: 'none', path: '', version: '', pinned: false, passed }
  }
  const engine = world.engine()
  if ('path' in engine) return { origin: 'engine', path: engine.path, version: engine.version, pinned: false, passed }
  passed.push(`the bundled engine is unavailable: ${engine.absent}`)
  return { origin: 'none', path: '', version: '', pinned: false, passed }
}

function gitProgramsDir(bashPath: string): string {
  const holder = dirname(bashPath)
  const parent = dirname(holder)
  return basename(holder).toLowerCase() === 'bin' && basename(parent).toLowerCase() === 'usr' ? holder : join(parent, 'usr', 'bin')
}

export function describeBashCandidate(path: string, fileExists: (file: string) => boolean = existsSync): BashCandidate {
  const dir = gitProgramsDir(path)
  return { path, runtimeBeside: fileExists(join(dir, POSIX_RUNTIME_FILE)), programsMissing: BASH_COMPANION_PROGRAMS.filter(name => !fileExists(join(dir, `${name}.exe`))) }
}

export function windowsBashCandidates(): { pinned: string | null; installed: () => BashCandidate[] } {
  if (installedBashHidden()) return { pinned: null, installed: () => [] }
  return { pinned: pinnedGitBash(), installed: () => installedGitBashes().map(path => describeBashCandidate(path)) }
}

export function pinPassedOver(passed: readonly string[]): string | null {
  if (passed.length === 0 || !windowsShellRoadActive()) return null
  const pin = windowsBashCandidates().pinned
  return pin === null ? null : (passed.find(line => line.startsWith(pinWords(pin))) ?? null)
}

type ToolPrograms = { from: 'path' } | { from: 'git' | 'pack'; dir: string; key: string; path: string } | { from: 'nowhere' }

type ProgramsWorld = { platform: string; gitBash: GitBashLocation; packDir?: string | null }

function lsResolves(path: string, platform: string): boolean {
  const found = resolveExecutable('ls', { platform, path })
  return found !== null && hasRequiredProgramExtension(found, platform)
}

const pathKeyOf = (env: NodeJS.ProcessEnv, platform: string): string => Object.keys(env).find(name => envVarKey(name, platform) === 'PATH') ?? 'PATH'

const pathLedBy = (dir: string, rest: string, platform: string): string => (rest === '' ? dir : `${dir}${pathDelimiter(platform)}${rest}`)

export function toolPrograms(
  env: NodeJS.ProcessEnv,
  world: ProgramsWorld | null = windowsShellRoadActive() ? { platform: process.platform, gitBash: locatedWindowsBash(), packDir: shippedWindowsBash()?.programsDir ?? null } : null,
): ToolPrograms {
  if (world === null) return { from: 'path' }
  const key = pathKeyOf(env, world.platform)
  const rest = env[key] ?? ''
  if (lsResolves(rest, world.platform)) return { from: 'path' }
  if ('path' in world.gitBash) {
    const dir = gitProgramsDir(world.gitBash.path)
    if (lsResolves(dir, world.platform)) return { from: 'git', dir, key, path: pathLedBy(dir, rest, world.platform) }
  }
  const packDir = world.packDir ?? null
  if (packDir !== null && lsResolves(packDir, world.platform)) return { from: 'pack', dir: packDir, key, path: pathLedBy(packDir, rest, world.platform) }
  return { from: 'nowhere' }
}

export function withGitPrograms(env: NodeJS.ProcessEnv, world?: ProgramsWorld | null): NodeJS.ProcessEnv {
  const programs = toolPrograms(env, world)
  return programs.from === 'git' || programs.from === 'pack' ? { ...env, [programs.key]: programs.path } : env
}

export function withProgramsFirst(env: NodeJS.ProcessEnv, dir: string, platform: string = process.platform): NodeJS.ProcessEnv {
  const key = pathKeyOf(env, platform)
  const rest = env[key] ?? ''
  const separator = pathDelimiter(platform)
  if (rest === dir || rest.startsWith(`${dir}${separator}`)) return env
  return { ...env, [key]: pathLedBy(dir, rest, platform) }
}

const SHELL_START_FILE_VARIABLES = ['BASH_ENV', 'ENV']
const ENGINE_REFUSES = ['BASH_ENV']

export function withoutShellStartFiles(env: NodeJS.ProcessEnv, platform: string = process.platform, names: readonly string[] = SHELL_START_FILE_VARIABLES): NodeJS.ProcessEnv {
  const named = Object.keys(env).filter(name => names.includes(envVarKey(name, platform)))
  if (named.length === 0) return env
  const kept = { ...env }
  for (const name of named) delete kept[name]
  return kept
}

export function withShippedPrograms(env: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
  if (!windowsShellRoadActive()) return env
  const shipped = shippedWindowsBash()
  return shipped === null || shipped.programsDir === null || shipped.path !== shellPath ? env : withProgramsFirst(env, shipped.programsDir)
}

export function withOwnPrograms(env: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
  if (!windowsShellRoadActive()) return env
  const dir = dirname(shellPath)
  return gitProgramsDir(shellPath) === dir && lsResolves(dir, process.platform) ? withProgramsFirst(env, dir) : env
}

function programsReach(bashPath: string): boolean {
  const env = subprocessEnv()
  return lsResolves(gitProgramsDir(bashPath), process.platform) || lsResolves(env[pathKeyOf(env, process.platform)] ?? '', process.platform)
}

export function withoutWhatTheEngineRefuses(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutShellStartFiles(env, process.platform, ENGINE_REFUSES)
}

function withoutEmptyPathConversionSwitch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!windowsShellRoadActive()) return env
  const empty = Object.keys(env).filter(name => name.toUpperCase() === 'MSYS_NO_PATHCONV' && env[name] === '')
  if (empty.length === 0) return env
  const kept = { ...env }
  for (const name of empty) delete kept[name]
  return kept
}

export function withRoadPrograms(env: NodeJS.ProcessEnv, origin: ShellOrigin, shellPath: string): NodeJS.ProcessEnv {
  if (origin === 'engine') return withoutWhatTheEngineRefuses(windowsShellRoadActive() ? withGitPrograms(env) : env)
  return withoutEmptyPathConversionSwitch(origin === 'system' ? withOwnPrograms(env, shellPath) : withShippedPrograms(env, shellPath))
}

function resolvedShellEngine(): ShellEngineResolution {
  const { resolveShellEngine } = require('./engineSession.js') as typeof import('./engineSession.js')
  const { getInitialSettings } = require('../settings/settings.js') as typeof import('../settings/settings.js')
  return resolveShellEngine(getInitialSettings().shell?.engine)
}

function armedShellEngine(): ShellEngineBinary {
  const resolved = resolvedShellEngine()
  return resolved.engine === 'brush' ? { path: resolved.binaryPath, arm: resolved.arm } : null
}

export function engineMayServe(): boolean {
  const engine = resolvedShellEngine()
  return !(engine.engine === 'system' && engine.requested === 'system' && engine.arm !== 'default')
}

const firstWindowsBashRoad = memoize((): WindowsBashRoad => composeWindowsBashRoad(locatedWindowsBash(), shippedWindowsBash(), armedShellEngine()))

export function roadOfRecord(first: WindowsBashRoad, settled: ShellRecord | null, noneStarts = false): WindowsBashRoad {
  if (first.kind === 'engine' || first.kind === 'absent') return first
  if (noneStarts) return { kind: 'absent', remedy: GIT_BASH_REMEDY }
  if (settled === null) return first
  if (settled.origin === 'engine') return { kind: 'engine', path: settled.path, arm: 'fallback' }
  return settled.origin === 'shipped' ? { kind: 'shipped', path: settled.path } : { kind: 'git-bash', path: settled.path }
}

export function windowsBashRoad(): WindowsBashRoad {
  const record = shellRecordDoor()
  return roadOfRecord(firstWindowsBashRoad(), record.settledSystemShell(), record.noSystemShellStarts())
}

export function bashToolAvailable(): boolean {
  return !windowsShellRoadActive() || windowsBashRoad().kind !== 'absent'
}

export function windowsShellRoadNotice(): string | null {
  if (!windowsShellRoadActive()) return null
  return windowsBashRoad().kind === 'absent' ? WINDOWS_BASH_NOTICE : null
}

export async function hookBashShell(hookCommand: string): Promise<string> {
  if (firstWindowsBashRoad().kind !== 'absent') await shellRecordDoor().settleShellRecord()
  const road = windowsBashRoad()
  if (road.kind === 'absent') {
    throw new Error(`Hook "${hookCommand}" runs under bash, and no bash is available: ${road.remedy}`)
  }
  return road.path
}

function withShellOfThisProcess(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shell = subprocessEnv().SHELL
  if (env.SHELL === shell) return env
  const own = { ...env }
  if (shell === undefined) delete own.SHELL
  else own.SHELL = shell
  return own
}

export function hookBashEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const road = windowsBashRoad()
  const own = withShellOfThisProcess(env)
  if (road.kind === 'absent') return own
  return withRoadPrograms(own, road.kind === 'engine' ? 'engine' : road.kind === 'git-bash' ? 'system' : 'shipped', road.path)
}

function engineRoadLine(road: { path: string; arm: RoadEngineArm }): string {
  const programs = toolPrograms(subprocessEnv())
  const lent =
    programs.from === 'git'
      ? `; ls, cat, grep and the like come from Git for Windows (${programs.dir}, first on its path)`
      : programs.from === 'pack'
        ? `; ls, cat, grep and the like come from the bash pack Mercury ships (${programs.dir}, first on its path)`
        : null
  if (road.arm === 'no-bash' || road.arm === 'fallback') {
    const why = road.arm === 'no-bash' ? 'no bash.exe was found on this machine' : 'no bash 5 starts on this machine, neither an installed one nor the one Mercury ships'
    return `the bundled shell engine at ${road.path} — ${why}, so the Bash tool runs under Mercury's own bash-compatible engine${programs.from === 'nowhere' ? '; ls, cat, grep and the like are not on this machine: Git for Windows carries them' : (lent ?? '')}`
  }
  return lent !== null
    ? `the shell engine at ${road.path} — the Bash tool runs under it (${shellEngineArmWords(road.arm)})${lent}`
    : `the shell engine at ${road.path} — the Bash tool runs under it (${shellEngineArmWords(road.arm)}), no Git dependency`
}

export function describeWindowsShellRoad(): {
  road: 'system' | 'git-bash' | 'shipped' | 'engine' | 'absent'
  absent: boolean
  unasked?: boolean
  bare?: boolean
  line: string
  fix?: string
} {
  if (!windowsShellRoadActive()) {
    return { road: 'system', absent: shellRecordDoor().noSystemShellStarts(), line: shellRecordDoor().shellRoadWordsNow() }
  }
  const road = windowsBashRoad()
  const settled = shellRecordDoor().settledSystemShell()
  const known = settled !== null && settled.path === ('path' in road ? road.path : '') && settled.version !== '' ? `bash ${settled.version}` : 'bash'
  if (road.kind === 'git-bash') {
    const pinned = pinnedGitBash() === road.path
    if (pinned && settled === null) {
      return { road: 'git-bash', absent: false, unasked: true, line: `${road.path} — named by MERCURY_GIT_BASH_PATH; whether it is a bash is asked when the Bash tool is first offered, and a program that does not answer as one is passed over` }
    }
    if (pinned && !programsReach(road.path)) {
      return { road: 'git-bash', absent: false, bare: true, line: `${known} at ${road.path} — named by MERCURY_GIT_BASH_PATH; the Bash tool runs under it; no ls, grep or sed stands beside it or on PATH`, fix: PIN_WAYS_OUT }
    }
    return { road: 'git-bash', absent: false, line: `${known} at ${road.path} — ${pinned ? 'named by MERCURY_GIT_BASH_PATH' : 'found on this machine'}; the Bash tool runs under it` }
  }
  if (road.kind === 'shipped') return { road: 'shipped', absent: false, line: `${known} at ${road.path} — the bash Mercury ships; the Bash tool runs under it, no bash 5 being installed on this machine` }
  if (road.kind === 'engine') return { road: 'engine', absent: false, line: engineRoadLine(road) }
  const engine = resolvedShellEngine()
  const noPack = engine.engine === 'system' && engine.requested === 'brush'
  const why = engine.engine === 'system' && engine.requested === 'brush' ? engine.reason : `the shell engine is turned off (${shellEngineArmWords(engine.arm)})`
  if (firstWindowsBashRoad().kind !== 'absent') {
    return {
      road: 'absent',
      absent: true,
      line: 'no bash starts on this machine, neither an installed one nor the one Mercury ships, and the bundled engine does not serve — a session here has no shell tool',
      fix: NO_SHELL_WAYS_OUT,
    }
  }
  return {
    road: 'absent',
    absent: true,
    line: `no bash.exe found and ${why} — the Bash tool is absent from the roster; the PowerShell tool is present`,
    fix: noPack ? WINDOWS_BASH_NOTICE_NO_PACK : WINDOWS_BASH_NOTICE,
  }
}

export function shellEnvForRoad(road: WindowsBashRoad, gitBash: GitBashLocation): string | null {
  if (road.kind === 'git-bash' || road.kind === 'shipped') return road.path
  if (road.kind === 'engine' && 'path' in gitBash) return gitBash.path
  return null
}

let armedShell: { before: string | undefined; set: string } | null = null

export function shellFollowsTheRecord(served: string | null): void {
  if (armedShell === null || firstWindowsBashRoad().kind === 'engine') return
  const { before, set } = armedShell
  if (subprocessEnv().SHELL !== set || served === set) return
  armedShell = null
  exportShell(served ?? before ?? '')
  logForDebugging(`windows shell road: SHELL was ${set} and follows the record: ${served ?? before ?? 'empty, the record having settled on nothing'}`)
}

function exportShell(shell: string): void {
  hostEnv().SHELL = shell
}

export function armWindowsShellRoad(): void {
  if (!windowsShellRoadActive()) return
  const road = firstWindowsBashRoad()
  const shell = shellEnvForRoad(road, locatedWindowsBash())
  if (shell !== null) {
    armedShell = { before: subprocessEnv().SHELL, set: shell }
    exportShell(shell)
    logForDebugging(`windows shell road: SHELL set to ${shell}`)
  }
  if (road.kind === 'engine') {
    logForDebugging(`windows shell road: the shell engine at ${road.path} (${shellEngineArmWords(road.arm === 'fallback' ? 'no-bash' : road.arm)})`)
    return
  }
  if (road.kind === 'git-bash' || road.kind === 'shipped') return
  logForDebugging(`windows shell road: ${WINDOWS_BASH_NOTICE}`, { level: 'warn' })
}
