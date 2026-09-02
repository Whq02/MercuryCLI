import { existsSync } from 'node:fs'
import { join } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { getPlatform, type Platform } from '../platform.js'

/**
 * Managed-policy root resolution: the Mercury-named root per platform —
 * no ClaudeCode filesystem roots.
 */

/** The candidates in priority order per platform (contract data). Windows
 *  policy lives under %ProgramData% — the machine-wide config root an admin
 *  writes after install — never under the binaries' Program Files root. */
export function managedRootCandidates(platform: Platform): string[] {
  switch (platform) {
    case 'macos':
      return ['/Library/Application Support/Mercury']
    case 'windows': {
      const programData = process.env.ProgramData ?? 'C:\\ProgramData'
      return [`${programData}\\Mercury`]
    }
    default:
      return ['/etc/mercury']
  }
}

/**
 * First existing candidate wins; a throwing probe falls through to the
 * next candidate; none existing documents the Mercury path. Pure — the
 * existence probe is injected.
 */
export function resolveManagedRoot(candidates: string[], exists: (path: string) => boolean): string {
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      // Unreadable path: fall through, never propagate.
    }
  }
  return candidates[0] as string
}

/** The resolved managed root, memoised per process (deliberate: a root appearing mid-session is not picked up). */
export const getManagedFilePath = memoize((): string => {
  return resolveManagedRoot(managedRootCandidates(getPlatform()), existsSync)
})

/** The drop-in directory under the resolved root (contract data: the directory name). */
export const getManagedSettingsDropInDir = memoize((): string => {
  return join(getManagedFilePath(), 'managed-settings.d')
})
