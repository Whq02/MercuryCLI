import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, writeSync } from 'node:fs'
import { dirname, resolve, sep, win32 as pathWin32 } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { releaseLauncherAltHoldNow } from '../ink/launcherAltHold.js'

import { logForDebugging } from './debug.js'
import { memoizeWithLRU } from './memoize.js'


function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch {
    return false
  }
}

function findExecutableCandidates(name: string): string[] {
  const candidates: string[] = []
  try {
    const result = spawnSync('where.exe', [name], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...subprocessEnv() },
    })
    if (result.status === 0 && result.stdout) {
      const cwdLower = process.cwd().toLowerCase()
      for (const line of result.stdout.split('\r\n')) {
        if (line === '') continue
        const resolved = resolve(line)
        const resolvedLower = resolved.toLowerCase()
        if (dirname(resolved).toLowerCase() === cwdLower || resolvedLower.startsWith(cwdLower + sep)) {
          logForDebugging(`windowsPaths: skipping ${resolved} (inside the working directory)`)
          continue
        }
        candidates.push(line)
      }
    }
  } catch {
  }
  if (name === 'git') {
    for (const classic of [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]) {
      if (pathExists(classic)) candidates.push(classic)
    }
  }
  return candidates
}

export function gitBashCandidatePaths(gitPaths: string[]): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (candidate: string): void => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  for (const gitPath of gitPaths) {
    push(pathWin32.join(pathWin32.dirname(pathWin32.dirname(gitPath)), 'bin', 'bash.exe'))
    const holder = pathWin32.dirname(gitPath)
    const holderName = pathWin32.basename(holder).toLowerCase()
    const parent = pathWin32.dirname(holder)
    const parentName = pathWin32.basename(parent).toLowerCase()
    const installRoot =
      holderName === 'bin' && (parentName === 'mingw64' || parentName === 'mingw32' || parentName === 'usr')
        ? pathWin32.dirname(parent)
        : parent
    push(pathWin32.join(installRoot, 'bin', 'bash.exe'))
  }
  push('C:\\Program Files\\Git\\bin\\bash.exe')
  push('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return candidates
}

export type GitBashLocation = { path: string } | { absent: true }

export const GIT_BASH_REMEDY =
  'Mercury on Windows requires git-bash for the Bash tool. Download it from https://git-scm.com/downloads/win — ' +
  'if it is already installed but not on PATH, set MERCURY_GIT_BASH_PATH=<path to your bash.exe> ' +
  '(for example C:\\Program Files\\Git\\bin\\bash.exe) — or turn the shell engine on.'

export const locateGitBash = memoize((): GitBashLocation => {
  const override = process.env.MERCURY_GIT_BASH_PATH
  if (override !== undefined && override !== '') {
    if (pathExists(override)) return { path: override }
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, `Error: unable to find MERCURY_GIT_BASH_PATH at ${override} — the path does not exist.\n`)
    } catch {
    }
    process.exit(1)
  }
  for (const candidate of gitBashCandidatePaths(findExecutableCandidates('git'))) {
    if (pathExists(candidate)) return { path: candidate }
  }
  return { absent: true }
})

export function findGitBashPath(): string {
  const location = locateGitBash()
  if ('path' in location) return location.path
  throw new Error(GIT_BASH_REMEDY)
}

export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    if (windowsPath.startsWith('\\\\')) {
      return `//${windowsPath.slice(2).replace(/\\/g, '/')}`
    }
    const driveMatch = windowsPath.match(/^([A-Za-z]):([\\/])(.*)$/s)
    if (driveMatch) {
      const drive = (driveMatch[1] as string).toLowerCase()
      const rest = (driveMatch[3] as string).replace(/\\/g, '/')
      return `/${drive}/${rest}`
    }
    return windowsPath.replace(/\\/g, '/')
  },
  windowsPath => windowsPath,
  500,
)

export function nativeCwdFromShellRecord(record: string): { path: string } | { refused: string } {
  const lines = record
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const posix = lines[0]
  if (posix === undefined) return { refused: 'the shell recorded no directory (the command may have died before writing it)' }
  const native = lines[1]
  if (native !== undefined) return { path: posixPathToWindowsPath(native) }
  const converted = posixPathToWindowsPath(posix)
  if (/^\\(?!\\)/.test(converted)) {
    return {
      refused: `${posix} is an MSYS virtual root the converter cannot place (it would become the drive-relative ${converted}); the shell's own Win32 spelling (pwd -W) was not recorded`,
    }
  }
  return { path: converted }
}

export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    if (posixPath.startsWith('//')) {
      return `\\\\${posixPath.slice(2).replace(/\//g, '\\')}`
    }
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/.*)?$/s)
    if (cygdriveMatch) {
      const rest = (cygdriveMatch[2] ?? '').replace(/\//g, '\\')
      return `${(cygdriveMatch[1] as string).toUpperCase()}:${rest === '' ? '\\' : rest}`
    }
    const msysMatch = posixPath.match(/^\/([A-Za-z])(\/.*)?$/s)
    if (msysMatch) {
      const rest = (msysMatch[2] ?? '').replace(/\//g, '\\')
      return `${(msysMatch[1] as string).toUpperCase()}:${rest === '' ? '\\' : rest}`
    }
    return posixPath.replace(/\//g, '\\')
  },
  posixPath => posixPath,
  500,
)
