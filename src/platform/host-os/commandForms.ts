import { getPlatform, type Platform } from '../environment/platform.js'
import { win32ToPosixPath } from './paths.js'

export function isCmdDriveSwitchCd(operands: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && operands.length === 2 && /^\/d$/i.test(operands[0]!)
}

export function readWorldUsesWindowsForms(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

export function shellFolderComparisonKey(path: string, platform: Platform = getPlatform()): string {
  if (platform !== 'windows') return path
  const posix = win32ToPosixPath(path).replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`)
  return posix.length > 1 && posix.endsWith('/') ? posix.slice(0, -1) : posix
}
