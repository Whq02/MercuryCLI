import { existsSync, statSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

export type PowerShellEdition = 'core' | 'desktop'

const LINUX_NON_SNAP_CANDIDATES = ['/opt/microsoft/powershell/7/pwsh', '/usr/bin/pwsh']

function resolveSymlink(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function isUnderSnap(path: string): boolean {
  return path.startsWith('/snap/') || resolveSymlink(path).startsWith('/snap/')
}

export async function findPowerShell(): Promise<string | null> {
  const pwsh = await which('pwsh')
  if (pwsh) {
    if (getPlatform() === 'linux' && isUnderSnap(pwsh)) {
      for (const candidate of LINUX_NON_SNAP_CANDIDATES) {
        if (!existsSync(candidate)) continue
        try {
          if (!statSync(candidate).isFile()) continue
        } catch {
          continue
        }
        if (!isUnderSnap(candidate)) return candidate
      }
    }
    return pwsh
  }
  const powershell = await which('powershell')
  return powershell ?? null
}

let cachedPowerShellPath: Promise<string | null> | null = null

export function getCachedPowerShellPath(): Promise<string | null> {
  cachedPowerShellPath ??= findPowerShell()
  return cachedPowerShellPath
}

function editionFromPath(path: string): PowerShellEdition {
  const segments = path.split(/[/\\]/)
  const name = (segments[segments.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '')
  return name === 'pwsh' ? 'core' : 'desktop'
}

export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const path = await getCachedPowerShellPath()
  return path ? editionFromPath(path) : null
}
