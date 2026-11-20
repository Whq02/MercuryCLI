import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

export function foldPathCase(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? filePath.toLowerCase() : filePath
}

export function samePathCase(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldPathCase(left, platform) === foldPathCase(right, platform)
}

export function pathModuleFor(platform: NodeJS.Platform = process.platform): typeof pathWin32 | typeof pathPosix {
  return platform === 'win32' ? pathWin32 : pathPosix
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
