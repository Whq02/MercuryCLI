import { coerce } from 'semver'

import { MERCURY_CHANGELOG } from '../constants/changelog.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logError } from './log.js'
import { gt } from './semver.js'


export function getStoredChangelogFromMemory(): string {
  return MERCURY_CHANGELOG
}

export async function getStoredChangelog(): Promise<string> {
  return MERCURY_CHANGELOG
}

export async function migrateChangelogFromConfig(): Promise<void> {
  const config = getGlobalConfig() as { cachedChangelog?: string }
  if (config.cachedChangelog === undefined) return
  saveGlobalConfig(current => {
    const { cachedChangelog: _dropped, ...rest } = current as { cachedChangelog?: string } & Record<string, unknown>
    return rest as typeof current
  })
}

export function parseChangelog(content: string): Record<string, string[]> {
  try {
    if (!content) return {}
    const result: Record<string, string[]> = {}
    const sections = content.split(/^## /m).slice(1)
    for (const section of sections) {
      const lines = section.split('\n')
      const version = (lines[0] ?? '').split(' - ')[0]?.trim() ?? ''
      if (version === '') continue
      const notes = lines
        .filter(line => line.trim().startsWith('- '))
        .map(line => line.trim().slice(2).trim())
        .filter(note => note !== '')
      if (notes.length === 0) continue
      result[version] = notes
    }
    return result
  } catch (err) {
    logError(err)
    return {}
  }
}

const RECENT_NOTES_CAP = 5

export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent: string = getStoredChangelogFromMemory(),
): string[] {
  try {
    const current = coerce(currentVersion)?.version
    const previous = previousVersion ? coerce(previousVersion)?.version : undefined
    const epochReset = current !== undefined && previous !== undefined && gt(previous, current)
    const showNotes =
      previous === undefined || epochReset || (current !== undefined && gt(current, previous))
    if (!showNotes) return []
    const parsed = parseChangelog(changelogContent)
    const versions = Object.keys(parsed)
      .filter(version => {
        if (previous === undefined || epochReset) return true
        try {
          return gt(version, previous)
        } catch {
          return false
        }
      })
      .sort((a, b) => {
        try {
          return gt(a, b) ? -1 : 1
        } catch {
          return 0
        }
      })
    const notes: string[] = []
    for (const version of versions) {
      notes.push(...(parsed[version] ?? []))
    }
    return notes.filter(note => note !== '').slice(0, RECENT_NOTES_CAP)
  } catch (err) {
    logError(err)
    return []
  }
}

export function getAllReleaseNotes(changelogContent: string = getStoredChangelogFromMemory()): Array<[string, string[]]> {
  try {
    const parsed = parseChangelog(changelogContent)
    return Object.entries(parsed)
      .map(([version, notes]) => [version, notes.filter(note => note !== '')] as [string, string[]])
      .filter(([, notes]) => notes.length > 0)
      .sort(([a], [b]) => {
        try {
          return gt(a, b) ? 1 : -1
        } catch {
          return 0
        }
      })
  } catch (err) {
    logError(err)
    return []
  }
}

function currentVersionDefault(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : '0.0.0'
}

function checkForReleaseNotesImpl(
  lastSeenVersion: string | null | undefined,
  currentVersion: string,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  const releaseNotes = getRecentReleaseNotes(currentVersion, lastSeenVersion)
  return { hasReleaseNotes: releaseNotes.length > 0, releaseNotes }
}

export async function checkForReleaseNotes(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = currentVersionDefault(),
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  return checkForReleaseNotesImpl(lastSeenVersion, currentVersion)
}

export function checkForReleaseNotesSync(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = currentVersionDefault(),
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  return checkForReleaseNotesImpl(lastSeenVersion, currentVersion)
}
