import { existsSync, realpathSync, statSync } from 'node:fs'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'
import { passedOver } from '../passedOver.js'

type PowerShellEdition = 'core' | 'desktop'

const LINUX_NON_SNAP_CANDIDATES = ['/opt/microsoft/powershell/7/pwsh', '/usr/bin/pwsh']

function resolveSymlink(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    passedOver(error)
    return path
  }
}

function isUnderSnap(path: string): boolean {
  return path.startsWith('/snap/') || resolveSymlink(path).startsWith('/snap/')
}

async function findPowerShell(): Promise<string | null> {
  const pwsh = await which('pwsh')
  if (pwsh) {
    if (getPlatform() === 'linux' && isUnderSnap(pwsh)) {
      for (const candidate of LINUX_NON_SNAP_CANDIDATES) {
        if (!existsSync(candidate)) continue
        try {
          if (!statSync(candidate).isFile()) continue
        } catch (error) {
          passedOver(error)
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
  if (cachedPowerShellPath === null) {
    cachedPowerShellPath = findPowerShell()
  }
  return cachedPowerShellPath
}

export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const path = await getCachedPowerShellPath()
  if (path === null) return null
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  return base === 'pwsh' ? 'core' : 'desktop'
}
