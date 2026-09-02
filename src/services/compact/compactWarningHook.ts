import { useSyncExternalStore } from 'react'

import { compactWarningStore } from './compactWarningState.js'

/**
 * React subscription to the compact-warning suppression flag. Kept in its own
 * module so the state module stays React-free (see compactWarningState.ts).
 */
export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getSnapshot,
    compactWarningStore.getSnapshot,
  )
}
