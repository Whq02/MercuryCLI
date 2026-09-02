import type { LocalCommandResult } from '../../types/command.js'
import { getAllReleaseNotes } from '../../utils/releaseNotes.js'

/**
 * The BUNDLED changelog, never a remote fetch. Notes arrive oldest-first and are reversed for
 * newest-first display.
 */
export async function call(): Promise<LocalCommandResult> {
  const notes = getAllReleaseNotes()
  if (notes.length === 0) {
    return {
      type: 'text',
      value:
        'No bundled release notes in this build. See docs/README.md in the repository, or run `git log --oneline` for the change history.',
    }
  }
  const blocks = [...notes]
    .reverse()
    .map(([version, versionNotes]) =>
      [`Version ${version}:`, ...versionNotes.map(note => `• ${note}`)].join('\n'),
    )
  return { type: 'text', value: blocks.join('\n\n') }
}
