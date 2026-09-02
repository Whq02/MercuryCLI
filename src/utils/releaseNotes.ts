import { coerce } from 'semver'

import { MERCURY_CHANGELOG } from '../constants/changelog.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logError } from './log.js'
import { gt } from './semver.js'

/**
 * Mercury's release notes are BUNDLED — the compiled-in constant is the one
 * source. The inherited design downloaded another product's changelog and
 * cached it; showing that history as Mercury's own was a correctness bug.
 * This module performs no network access, names no upstream location, and
 * treats any changelog cache left on disk by an earlier build as if it did
 * not exist.
 */

export function getStoredChangelogFromMemory(): string {
  return MERCURY_CHANGELOG
}

/** Async form; must resolve effectively instantly — nothing is fetched. */
export async function getStoredChangelog(): Promise<string> {
  return MERCURY_CHANGELOG
}

/** One-time config hygiene: the deprecated cached-changelog field is removed by OMISSION, never nulled. */
export async function migrateChangelogFromConfig(): Promise<void> {
  const config = getGlobalConfig() as { cachedChangelog?: string }
  if (config.cachedChangelog === undefined) return
  saveGlobalConfig(current => {
    const { cachedChangelog: _dropped, ...rest } = current as { cachedChangelog?: string } & Record<string, unknown>
    return rest as typeof current
  })
}

/**
 * Sections split on level-two headings; the first fragment (the file
 * header) is discarded. The first line of a section carries the version —
 * bare, or followed by a date after ` - `. Notes are `- ` bullets; empty
 * sections and empty versions are omitted.
 */
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

/**
 * Notes since the previously-seen version. The versions are coerced to base
 * form (build/SHA suffixes stripped); the section keys are compared raw.
 * Version-epoch reset: Mercury restarted its numbering below the inherited
 * product's, so a "last seen" recorded under the old numbering compares as
 * AHEAD of every Mercury version — treat that as a fresh start and show the
 * current epoch's notes once.
 */
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

/** Version/notes pairs sorted OLDEST first; empty versions omitted. */
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

/** The async and sync forms share one body so they can never disagree. */
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
