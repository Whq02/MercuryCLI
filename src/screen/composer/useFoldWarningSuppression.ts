import { useSyncExternalStore } from 'react'
import { compactWarningStore } from '../../engine/compaction/foldWarningSuppression.js'

export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getSnapshot,
    compactWarningStore.getSnapshot,
  )
}
