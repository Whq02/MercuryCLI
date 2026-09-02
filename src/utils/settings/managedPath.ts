import { existsSync } from 'node:fs'
import { join } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { getPlatform, type Platform } from '../platform.js'


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

export function resolveManagedRoot(candidates: string[], exists: (path: string) => boolean): string {
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate
    } catch {
    }
  }
  return candidates[0] as string
}

export const getManagedFilePath = memoize((): string => {
  return resolveManagedRoot(managedRootCandidates(getPlatform()), existsSync)
})

export const getManagedSettingsDropInDir = memoize((): string => {
  return join(getManagedFilePath(), 'managed-settings.d')
})
