import { spawnSync } from 'node:child_process'
import { flagEnv } from '../substrate/flagRegistry.js'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, writeSync } from 'node:fs'
import { resolve, sep, win32 as pathWin32 } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { releaseLauncherAltHoldNow } from '../ink/launcherAltHold.js'

import { logForDebugging } from './debug.js'
import { memoizeWithLRU } from './memoize.js'
import { passedOver } from './passedOver.js'
import {
  nativeCwdFromRecordedShell,
  posixToWin32Path,
  stripExtendedLengthPrefixForPlatform,
  win32ToPosixPath,
  type RecordedCwd,
} from './platform/paths.js'


function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch (error) {
    passedOver(error)
    return false
  }
}

const CLASSIC_GIT_PATHS = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
] as const

const CLASSIC_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
] as const

function findExecutableCandidates(name: string): string[] {
  const candidates: string[] = []
  try {
    const result = spawnSync('where.exe', [name], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: subprocessEnv(),
    })
    if (result.status === 0 && !result.error && typeof result.stdout === 'string') {
      const resolvedCwd = resolve(process.cwd()).toLowerCase()
      const cwdPrefix = resolvedCwd.endsWith(sep) ? resolvedCwd : `${resolvedCwd}${sep}`
      for (const line of result.stdout.split(/\r?\n/)) {
        const entry = line.trim()
        if (entry === '') continue
        const resolvedEntry = resolve(entry).toLowerCase()
        if (resolvedEntry === resolvedCwd || resolvedEntry.startsWith(cwdPrefix)) {
          logForDebugging(`windowsPaths: skipping ${name} ${entry} (inside the working directory)`)
          continue
        }
        candidates.push(entry)
      }
    }
  } catch (error) {
    passedOver(error)
  }

  if (name === 'git') {
    for (const fallback of CLASSIC_GIT_PATHS) {
      if (pathExists(fallback)) candidates.push(fallback)
    }
  }

  return candidates
}

const GIT_TOOLCHAIN_FOLDERS: ReadonlySet<string> = new Set(['mingw64', 'mingw32', 'ucrt64', 'clang64', 'clangarm64', 'usr'])

export function gitBashCandidatePaths(gitPaths: string[]): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }

  for (const gitPath of gitPaths) {
    const gitDir = pathWin32.dirname(gitPath)
    const parentDir = pathWin32.dirname(gitDir)
    add(pathWin32.join(parentDir, 'bin', 'bash.exe'))
    if (
      pathWin32.basename(gitDir).toLowerCase() === 'bin' &&
      GIT_TOOLCHAIN_FOLDERS.has(pathWin32.basename(parentDir).toLowerCase())
    ) {
      add(pathWin32.join(pathWin32.dirname(parentDir), 'bin', 'bash.exe'))
    }
  }

  for (const fallback of CLASSIC_BASH_PATHS) {
    add(fallback)
  }

  return candidates
}

export type GitBashLocation = { path: string } | { absent: true }

export const GIT_BASH_REMEDY =
  'Mercury found no bash for the Bash tool on this Windows machine. Download Git for Windows from https://git-scm.com/downloads/win, ' +
  'set MERCURY_GIT_BASH_PATH=<path to bash.exe> ' +
  '(for example C:\\Program Files\\Git\\bin\\bash.exe) if one is already installed, or turn the shell engine on.'

function namedGitBash(): string | undefined {
  const named = flagEnv('MERCURY_GIT_BASH_PATH')?.trim().replace(/^"(.*)"$/, '$1').trim()
  return named !== undefined && named !== '' && !pathExists(named) && pathExists(`${named}.exe`) ? `${named}.exe` : named
}

export const locateGitBash = memoize((): GitBashLocation => {
  const override = namedGitBash()
  if (override !== undefined && override !== '') {
    if (pathExists(override)) return { path: override }
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, `Error: unable to find MERCURY_GIT_BASH_PATH at ${override} — the path does not exist.\n`)
    } catch (error) {
      passedOver(error)
    }
    process.exit(1)
  }
  for (const candidate of gitBashCandidatePaths(findExecutableCandidates('git'))) {
    if (pathExists(candidate)) return { path: candidate }
  }
  return { absent: true }
})

export function pinnedGitBash(): string | null {
  const override = namedGitBash()
  return override !== undefined && override !== '' && pathExists(override) ? override : null
}

export const installedGitBashes = memoize((): string[] => gitBashCandidatePaths(findExecutableCandidates('git')).filter(pathExists))

export function findGitBashPath(): string {
  const location = locateGitBash()
  if ('path' in location) return location.path
  throw new Error(GIT_BASH_REMEDY)
}

export const windowsPathToPosixPath = memoizeWithLRU(
  win32ToPosixPath,
  windowsPath => windowsPath,
  500,
)

export function nativeCwdFromShellRecord(record: string): RecordedCwd {
  return nativeCwdFromRecordedShell(record, true, 'windows')
}

export const WINDOWS_STARTS_A_PROGRAM_IN = 258

export function folderWindowsStartsIn(folder: string): string {
  let above = folder
  while (above.length > WINDOWS_STARTS_A_PROGRAM_IN && pathWin32.dirname(above) !== above) above = pathWin32.dirname(above)
  return above
}

export function stripExtendedLengthPrefix(path: string): string {
  return stripExtendedLengthPrefixForPlatform(path, 'win32')
}

export const posixPathToWindowsPath = memoizeWithLRU(
  posixToWin32Path,
  posixPath => posixPath,
  500,
)
