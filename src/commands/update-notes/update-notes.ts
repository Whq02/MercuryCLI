import type { LocalCommandResult } from '../../types/command.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { earlierReleasesLine, getAllReleaseNotes } from '../../utils/releaseNotes.js'

function section(version: string, notes: string[]): string {
  return [`Version ${version}:`, ...notes.map(note => `• ${note}`)].join('\n')
}

export async function call(): Promise<LocalCommandResult> {
  const notes = getAllReleaseNotes()
  if (notes.length === 0) {
    return {
      type: 'text',
      value:
        'No bundled release notes in this build. See docs/README.md in the repository, or run `git log --oneline` for the change history.',
    }
  }
  const newestFirst = [...notes].reverse()
  const printsForAScript = getIsNonInteractiveSession() && flagEnv('MERCURY_CONCOURSE_WORKER') !== '1'
  if (printsForAScript) {
    return { type: 'text', value: newestFirst.map(([version, versionNotes]) => section(version, versionNotes)).join('\n\n') }
  }
  const runningAt = newestFirst.findIndex(([version]) => version === MERCURY_VERSION)
  const shownAt = runningAt >= 0 ? runningAt : 0
  const shown = newestFirst[shownAt]!
  const earlier = newestFirst.filter((_, index) => index !== shownAt)
  const blocks = [section(shown[0], shown[1])]
  if (earlier.length > 0) {
    blocks.push(earlierReleasesLine(earlier.length), ...earlier.map(([version, versionNotes]) => section(version, versionNotes)))
  }
  return { type: 'text', value: blocks.join('\n\n') }
}
