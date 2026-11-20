import * as hostPath from 'node:path'
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
