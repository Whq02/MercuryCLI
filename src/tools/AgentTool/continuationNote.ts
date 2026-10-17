import { getCwdState } from '../../bootstrap/state.js'

export type ContinuationDirectoryFacts = {
  cwdFallback?: 'parent-checkout' | 'parent-directory'
  recordedCwd?: string
}

export const PARENT_CHECKOUT_NOTE =
  ' Its worktree is gone (already folded or cleaned), so the resumed crewmate runs in the parent checkout and edits the main tree.'

export function continuationDirectoryNote(resumed: ContinuationDirectoryFacts, sessionDirectory: string = getCwdState()): string {
  if (resumed.cwdFallback === 'parent-checkout') return PARENT_CHECKOUT_NOTE
  if (resumed.cwdFallback === 'parent-directory') {
    const recorded = resumed.recordedCwd === undefined ? 'its recorded directory' : `its recorded directory ${resumed.recordedCwd}`
    return ` NOTE: ${recorded} is gone — the continued crewmate runs in the session's own directory, ${sessionDirectory}; anything it edits lands there.`
  }
  return ''
}
