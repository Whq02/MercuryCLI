/**
 * Locates a PowerShell executable, caches it, and infers its edition from the
 * binary name (without spawning a process).
 */
import { existsSync, statSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

/** core = PowerShell 7+, desktop = Windows PowerShell 5.1. */
export type PowerShellEdition = 'core' | 'desktop'

/** Known non-snap install locations probed on Linux (in order). */
const LINUX_NON_SNAP_CANDIDATES = ['/opt/microsoft/powershell/7/pwsh', '/usr/bin/pwsh']

/** Resolve a path's symlink chain, tolerating failure (the original stands in). */
function resolveSymlink(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Whether a path or its resolution is under /snap/. */
function isUnderSnap(path: string): boolean {
  return path.startsWith('/snap/') || resolveSymlink(path).startsWith('/snap/')
}

/**
 * Locate a PowerShell executable. Prefer `pwsh`, then `powershell`; null when
 * neither resolves. On Linux, avoid a snap launcher shim by probing known
 * non-snap install locations. Uncached.
 */
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
        // Accept only when neither the candidate nor its resolution is snap.
        if (!isUnderSnap(candidate)) return candidate
      }
      // No non-snap candidate: fall through to the original PATH hit.
    }
    return pwsh
  }
  const powershell = await which('powershell')
  return powershell ?? null // returned as found; only pwsh is post-processed
}

let cachedPowerShellPath: Promise<string | null> | null = null

/** The memoised PowerShell path (the promise is cached, so concurrent callers share it). */
export function getCachedPowerShellPath(): Promise<string | null> {
  cachedPowerShellPath ??= findPowerShell()
  return cachedPowerShellPath
}

/** Infer the edition from the executable file name, without spawning. */
function editionFromPath(path: string): PowerShellEdition {
  const segments = path.split(/[/\\]/)
  const name = (segments[segments.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '')
  return name === 'pwsh' ? 'core' : 'desktop'
}

/** The edition of the detected PowerShell, or null when none is available. */
export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const path = await getCachedPowerShellPath()
  return path ? editionFromPath(path) : null
}
