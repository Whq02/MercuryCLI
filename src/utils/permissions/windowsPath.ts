import { getPlatform } from '../platform.js'
import { uncPathRisk } from './uncPath.js'

const DOS_DEVICE_NAMES = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)])

export function suspiciousWindowsPattern(path: string): string | null {
  const platform = getPlatform()
  if (platform === 'windows' || platform === 'wsl') {
    for (let i = 2; i < path.length; i++) if (path[i] === ':') return 'NTFS alternate data stream'
  }
  if (/~\d/.test(path)) return '8.3 short name'
  if (/^(?:\\\\\?\\|\\\\\.\\|\/\/\?\/|\/\/\.\/)/.test(path)) return 'long-path or device prefix'
  if (/[.\s]$/.test(path)) return 'trailing dot or whitespace'
  if (DOS_DEVICE_NAMES.has(path.split(/[./\\]/).pop()?.toLowerCase() ?? '')) return 'DOS device name'
  if (/(?:^|[/\\])\.{3,}(?:[/\\]|$)/.test(path)) return 'consecutive dots as a path component'
  return null
}

export function containsWindowsDevicePath(input: string): boolean {
  return getPlatform() === 'windows' && /[\\/]{2}[?.][\\/]/.test(input)
}

export function windowsPathNeedsPermission(input: string): boolean {
  return uncPathRisk(input).risky || containsWindowsDevicePath(input)
}

export const WINDOWS_DEVICE_PATH_MESSAGE = 'A Windows device namespace can bypass ordinary path checks and requires manual approval.'
