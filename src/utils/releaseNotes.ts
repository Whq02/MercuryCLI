import { coerce } from 'semver'

import { getMercuryChangelog } from '../constants/changelog.js'
import { logError } from './log.js'
import { gt } from './semver.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'


function getStoredChangelogFromMemory(): string {
  return getMercuryChangelog()
}

export async function getStoredChangelog(): Promise<string> {
  return notBuilt('src/utils/releaseNotes.ts:13')
}

function parseChangelog(content: string): Record<string, string[]> {
  return notBuilt('src/utils/releaseNotes.ts:17')
}

const RECENT_NOTES_CAP = 5

export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent?: string,
): string[] {
  return notBuilt('src/utils/releaseNotes.ts:42')
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
