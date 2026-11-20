import { statSync, type Stats } from 'node:fs'

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
