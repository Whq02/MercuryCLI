import { spawnSync } from 'node:child_process'
import { flagEnv } from '../substrate/flagRegistry.js'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, writeSync } from 'node:fs'
import { dirname, resolve, sep, win32 as pathWin32 } from 'node:path'

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
} from './platform/paths.js'
import { notBuilt } from '../pi/holes.js'


function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch (error) {
    passedOver(error)
    return false
  }
}

function findExecutableCandidates(name: string): string[] {
  return notBuilt('src/utils/windowsPaths.ts:31')
}

const GIT_TOOLCHAIN_FOLDERS: ReadonlySet<string> = new Set(['mingw64', 'mingw32', 'ucrt64', 'clang64', 'clangarm64', 'usr'])

export function gitBashCandidatePaths(gitPaths: string[]): string[] {
  return notBuilt('src/utils/windowsPaths.ts:70')
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

export function nativeCwdFromShellRecord(record: string): { path: string } | { refused: string } {
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
