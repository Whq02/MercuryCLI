import { coerce } from 'semver'

import { getMercuryChangelog } from '../commands/update-notes/changelog.js'
import { logError } from '../platform/logs/errorLog.js'
import { gt } from '../platform/primitives/semver.js'
import { passedOver } from '../platform/errors/passedOver.js'

function getStoredChangelogFromMemory(): string {
  return getMercuryChangelog()
}

export async function getStoredChangelog(): Promise<string> {
  return getMercuryChangelog()
}

function parseChangelog(content: string): Record<string, string[]> {
  try {
    const sections = new Map<string, string[]>()
    for (const section of content.split(/^## /m).slice(1)) {
      const [header = '', ...lines] = section.split('\n')
      const version = header.split(' - ', 1)[0]?.trim()
      if (!version) continue
      const notes = lines.map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(Boolean)
      if (notes.length) sections.set(version, notes)
    }
    return Object.fromEntries(sections)
  } catch (error) {
    logError(error)
    return {}
  }
}

const RECENT_NOTES_CAP = 5

export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent?: string,
): string[] {
  try {
    const current = coerce(currentVersion)?.version
    const previous = coerce(previousVersion)?.version
    if (previous && (!current || current === previous)) return []
    const reset = previous && current && gt(previous, current)
    return Object.entries(parseChangelog(changelogContent ?? getStoredChangelogFromMemory()))
      .filter(([version]) => {
        if (!previous || reset) return true
        try {
          return gt(version, previous)
        } catch (error) {
          passedOver(error)
          return false
        }
      })
      .sort(([a], [b]) => {
        try {
          return gt(a, b) ? -1 : gt(b, a) ? 1 : 0
        } catch (error) {
          passedOver(error)
          return 0
        }
      })
      .flatMap(([, notes]) => notes)
      .slice(0, RECENT_NOTES_CAP)
  } catch (error) {
    logError(error)
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
        } catch (error) {
          passedOver(error)
          return 0
        }
      })
  } catch (err) {
    logError(err)
    return []
  }
}

const EARLIER_RELEASES_LINE = /^\+(\d+) earlier releases?$/

export function earlierReleasesLine(count: number): string {
  return `+${count} earlier ${count === 1 ? 'release' : 'releases'}`
}

export function earlierReleasesCount(line: string): number | null {
  const match = EARLIER_RELEASES_LINE.exec(line.trim())
  return match ? Number(match[1]) : null
}
