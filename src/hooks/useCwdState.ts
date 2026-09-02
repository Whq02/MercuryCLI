// The harness ground AS RENDERED: the screen's working directory through the
// one subscribable cwd cell (bootstrap/state subscribeCwdState). Chrome that
// names the folder rides this hook so a ground move — the concourse repo
// pick, a cd-recording shell, a worktree exit — repaints the name on the
// move's own beat, instead of sampling getCwd() at render and healing on the
// next unrelated repaint.
//
// This is the SCREEN-ground read (the blank chat's ground). A surface whose
// truth is a specific session's workspace reads that connector's workspace
// door and uses subscribeCwdState as its re-read beat instead.

import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'

export function useCwdState(): string {
  return useSyncExternalStore(subscribeCwdState, getCwd, getCwd)
}
