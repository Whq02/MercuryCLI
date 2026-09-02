import { useSyncExternalStore } from 'react'

import { compactWarningStore } from './compactWarningState.js'

export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getSnapshot,
    compactWarningStore.getSnapshot,
  )
}
