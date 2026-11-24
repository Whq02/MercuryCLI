import { existsSync } from 'node:fs'
import * as hostPath from 'node:path'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { passedOver } from '../errors/passedOver.js'
import { getPlatform, type Platform } from '../environment/platform.js'

export function foldPathCase(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? filePath.toLowerCase() : filePath
}

export function foldCaseInsensitivePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' || platform === 'win32' ? filePath.toLowerCase() : filePath
}

export function foldHostCaseInsensitivePath(filePath: string, platform: Platform = getPlatform()): string {
  return platform === 'macos' || platform === 'windows' || platform === 'wsl' ? filePath.toLowerCase() : filePath
}

export function samePathCase(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldPathCase(left, platform) === foldPathCase(right, platform)
}

export function pathModuleFor(platform: NodeJS.Platform = process.platform): typeof pathWin32 | typeof pathPosix {
  return platform === 'win32' ? pathWin32 : pathPosix
}

export function hostOrWin32PathModule(platform: NodeJS.Platform = process.platform): typeof pathWin32 | typeof hostPath {
  return platform === 'win32' ? pathWin32 : hostPath
}

export function stripExtendedLengthPrefixForPlatform(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath
  if (/^\\\\\?\\UNC\\/i.test(filePath)) return '\\\\' + filePath.slice(8)
  if (filePath.startsWith('\\\\?\\')) return filePath.slice(4)
  return filePath
}

export function toPosixSeparators(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath
}

export function toNativeSeparators(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? filePath.replace(/\//g, '\\') : filePath
}

export function isWindowsShareRooted(
  filePath: string,
  allowMixed = true,
  platform: Platform = getPlatform(),
): boolean {
  return platform === 'windows' && (allowMixed ? /^[\\/]{2}/ : /^(\\\\|\/\/)/).test(filePath)
}

export function picomatchPathOptions(platform: NodeJS.Platform = process.platform): { dot: true; nocase: boolean } {
  return { dot: true, nocase: platform === 'win32' }
}

export function normalizedDriveRoot(filePath: string, platform: Platform = getPlatform()): string | null {
  return filePath.startsWith('/') ? '/' : platform === 'windows' && /^[A-Za-z]:\//.test(filePath) ? filePath.slice(0, 3) : null
}

export function ensureDriveRootSeparator(baseDir: string, platform: Platform = getPlatform()): string {
  return platform === 'windows' && /^[A-Za-z]:$/.test(baseDir) ? `${baseDir}\\` : baseDir
}

export function pathSeparatorRegex(platform: Platform = getPlatform()): RegExp {
  return platform === 'windows' ? /[/\\]/g : /\//g
}

export function expandTildeWithHome(filePath: string, home: string, platform: Platform = getPlatform()): string {
  if (filePath === '~') return home
  if (filePath.startsWith('~/')) return home + filePath.slice(1)
  if (platform === 'windows' && filePath.startsWith('~\\')) return home + filePath.slice(1)
  return filePath
}

export function preferredHomeEnv(env: NodeJS.ProcessEnv, platform: Platform = getPlatform()): string {
  return (platform === 'windows' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || ''
}

function joinPosixLexical(cwd: string, operand: string): string {
  const combined = `${cwd}/${operand}`
  const segments: string[] = []
  for (const segment of combined.split(pathPosix.sep)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return '/' + segments.join('/')
}

export function resolveLexicalOperandPath(cwd: string, operand: string, platform: Platform = getPlatform()): string {
  if (operand.startsWith('/') || (platform === 'windows' && /^[a-z]:[/\\]/i.test(operand))) return operand
  return platform === 'windows' ? pathWin32.resolve(cwd, operand) : joinPosixLexical(cwd, operand)
}

export function foldHostPathCase(filePath: string, platform: Platform = getPlatform()): string {
  return platform === 'windows' ? filePath.toLowerCase() : filePath
}

export function isEscapingRelativePath(relative: string, platform: Platform = getPlatform()): boolean {
  if (relative === '..' || relative.startsWith('../')) return true
  return platform === 'windows' && relative.startsWith('..\\')
}

export function extractPatternDriveRoot(
  pattern: string,
  sep: string,
  platform: Platform = getPlatform(),
): { root: string; relative: string } | null {
  if (platform !== 'windows') return null
  const drive = pattern.replace(/\\/g, '/').match(/^\/?([A-Za-z]):\/(.*)$/)
  if (!drive) return null
  return { root: `${drive[1]!.toUpperCase()}:${sep}`, relative: drive[2]! }
}

export function extractDoubleSlashPatternRoot(
  pattern: string,
  sep: string,
  platform: Platform = getPlatform(),
): { root: string; relative: string } {
  if (platform === 'windows') {
    const drive = pattern.match(/^\/\/([A-Za-z])\/(.*)$/)
    if (drive) return { root: `${drive[1]!.toUpperCase()}:${sep}`, relative: drive[2]! }
  }
  return { root: '/', relative: pattern.slice(1) }
}

export function splitPathFromRoot(
  filePath: string,
  grammar: typeof hostPath = hostPath,
): { root: string; segments: string[]; sep: string } {
  const parsedRoot = grammar.parse(filePath).root
  const root = parsedRoot || grammar.sep
  const rest = filePath.slice(parsedRoot.length)
  const segments = (grammar.sep === '\\' ? rest.split(/[\\/]+/) : rest.split(grammar.sep)).filter(Boolean)
  return { root, segments, sep: grammar.sep }
}

export function posixToWin32Path(posixPath: string): string {
  if (posixPath.startsWith('//')) return `\\\\${posixPath.slice(2).replace(/\//g, '\\')}`
  const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/.*)?$/s)
  if (cygdriveMatch) {
    const rest = (cygdriveMatch[2] ?? '').replace(/\//g, '\\')
    return `${cygdriveMatch[1]!.toUpperCase()}:${rest === '' ? '\\' : rest}`
  }
  const msysMatch = posixPath.match(/^\/([A-Za-z])(\/.*)?$/s)
  if (msysMatch) {
    const rest = (msysMatch[2] ?? '').replace(/\//g, '\\')
    return `${msysMatch[1]!.toUpperCase()}:${rest === '' ? '\\' : rest}`
  }
  return posixPath.replace(/\//g, '\\')
}

export function win32ToPosixPath(windowsPath: string): string {
  if (windowsPath.startsWith('\\\\')) return `//${windowsPath.slice(2).replace(/\\/g, '/')}`
  const driveMatch = windowsPath.match(/^([A-Za-z]):([\\/])(.*)$/s)
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase()
    const rest = driveMatch[3]!.replace(/\\/g, '/')
    return `/${drive}/${rest}`
  }
  return windowsPath.replace(/\\/g, '/')
}

export function shellPathToNative(filePath: string, platform: Platform = getPlatform()): string {
  return platform === 'windows' ? posixToWin32Path(filePath) : filePath
}

export function nativePathToShell(filePath: string, platform: Platform = getPlatform()): string {
  return platform === 'windows' ? win32ToPosixPath(filePath) : filePath
}

export function msysDrivePathToNative(
  filePath: string,
  allowBareDrive = false,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return filePath
  const re = allowBareDrive ? /^\/[A-Za-z](?:\/|$)/ : /^\/[A-Za-z]\//
  return re.test(filePath) ? posixToWin32Path(filePath) : filePath
}

export function hostPathSpellings(filePath: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [filePath, win32ToPosixPath(filePath)] : [filePath]
}

export function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch (error) {
    passedOver(error)
    return false
  }
}

function msysStoredSpelling(filePath: string): string {
  const from = /^[A-Za-z]:/.test(filePath) ? 2 : 0
  return filePath.slice(0, from) + filePath.slice(from).replace(/["*:<>?|]/g, forbidden => String.fromCharCode(0xf000 | forbidden.charCodeAt(0)))
}

function asStoredOnDisk(filePath: string): string {
  if (pathExists(filePath)) return filePath
  const stored = msysStoredSpelling(filePath)
  return stored !== filePath && pathExists(stored) ? stored : filePath
}

export type RecordedCwd = { path: string; refused?: never } | { refused: string; path?: never }

export function nativeCwdFromRecordedShell(
  record: string,
  trimOnPosix = true,
  platform: string = getPlatform(),
): RecordedCwd {
  if (platform !== 'windows') return { path: trimOnPosix ? record.trim() : record }
  const lines = record
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const posix = lines[0]
  if (posix === undefined) return { refused: 'the shell recorded no directory (the command may have died before writing it)' }
  const native = lines[1]
  if (native !== undefined) return { path: asStoredOnDisk(stripExtendedLengthPrefixForPlatform(posixToWin32Path(native), 'win32')) }
  const converted = stripExtendedLengthPrefixForPlatform(posixToWin32Path(posix), 'win32')
  if (/^\\(?!\\)/.test(converted)) {
    return {
      refused: `${posix} is an MSYS virtual root the converter cannot place (it would become the drive-relative ${converted}); the shell's own Win32 spelling (pwd -W) was not recorded`,
    }
  }
  return { path: converted }
}

const LOCAL_DEVICE_DRIVE = /^[\\/]{2}[?.][\\/]([A-Za-z]):(?:[\\/](.*))?$/
const LOCAL_HOST_DRIVE = /^[\\/]{2}(?:localhost|127\.0\.0\.1|\[?::1\]?)[\\/]([A-Za-z])\$(?:[\\/](.*))?$/i

export function normalizeLocalDevicePath(filePath: string, platform: Platform = getPlatform()): string {
  if (platform !== 'windows') return /^\/{2,}/.test(filePath) ? filePath.replace(/^\/+/, '/') : filePath
  const drive = LOCAL_DEVICE_DRIVE.exec(filePath) ?? LOCAL_HOST_DRIVE.exec(filePath)
  return drive === null ? filePath : `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
}
