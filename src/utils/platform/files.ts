import { constants as fsConstants, lstatSync, statSync, type Stats } from 'node:fs'
import { getPlatform, type Platform } from '../platform.js'

type PathEntryKind = 'absent' | 'directory' | 'other'

export function pathEntryKindSync(target: string): PathEntryKind {
  try {
    return lstatSync(target).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

export function isDirAbsentOnRmdirError(
  error: unknown,
  priorKind: PathEntryKind,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false
  if (platform === 'win32') return priorKind !== 'other'
  return true
}

export function posixFileModesApply(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function isPrivateFileMode(
  mode: number,
  forbiddenMask: number = 0o077,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return true
  return (mode & forbiddenMask) === 0
}

export function readExposedFileModeSync(
  file: string,
  forbiddenMask: number = 0o077,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform === 'win32') return null
  const mode = statSync(file).mode & 0o777
  return (mode & forbiddenMask) !== 0 ? mode : null
}

export function isOwnedPrivateEntry(
  stats: Pick<Stats, 'mode' | 'uid'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return true
  return (stats.mode & 0o077) === 0 && stats.uid === process.getuid?.()
}

export function exclusiveCreateNoFollowFlags(
  platform: NodeJS.Platform = process.platform,
): string | number {
  if (platform === 'win32') return 'wx'
  return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
}

export function appendNoFollowFlags(
  win32Flag: 'a' | 'w' = 'a',
  platform: Platform = getPlatform(),
): string | number {
  if (platform === 'windows') return win32Flag
  return fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0)
}

export function symlinksMayRequirePrivilege(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32'
}

export function symlinkDeniedByPrivilege(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return symlinksMayRequirePrivilege(platform) && (code === 'EPERM' || code === 'EACCES')
}
