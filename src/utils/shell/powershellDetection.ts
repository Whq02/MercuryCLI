import { existsSync, statSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'

type PowerShellEdition = 'core' | 'desktop'

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

export function getCachedPowerShellPath(): Promise<string | null> {
  return notBuilt('src/utils/shell/powershellDetection.ts:46')
}

export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  return notBuilt('src/utils/shell/powershellDetection.ts:57')
}
