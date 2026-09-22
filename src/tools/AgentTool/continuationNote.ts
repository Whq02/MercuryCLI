import { getCwdState } from '../../bootstrap/state.js'

export type ContinuationDirectoryFacts = {
  cwdFallback?: 'parent-checkout' | 'parent-directory'
  recordedCwd?: string
}

export const PARENT_CHECKOUT_NOTE =
  ' NOTE: its worktree is gone (already folded or cleaned) — the revived agent runs in the PARENT checkout; anything it edits lands in the real tree.'

export function continuationDirectoryNote(resumed: ContinuationDirectoryFacts, sessionDirectory: string = getCwdState()): string {
  if (resumed.cwdFallback === 'parent-checkout') return PARENT_CHECKOUT_NOTE
  if (resumed.cwdFallback === 'parent-directory') {
    const recorded = resumed.recordedCwd === undefined ? 'its recorded directory' : `its recorded directory ${resumed.recordedCwd}`
    return ` NOTE: ${recorded} is gone — the continued agent runs in the session's own directory, ${sessionDirectory}; anything it edits lands there.`
  }
  return ''
}
