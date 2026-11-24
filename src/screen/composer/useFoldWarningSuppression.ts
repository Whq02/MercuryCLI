import { useSyncExternalStore } from 'react'
import { foldWarningStore } from '../../engine/compaction/foldWarningSuppression.js'

export function useFoldWarningSuppression(): boolean {
  return useSyncExternalStore(
    foldWarningStore.subscribe,
    foldWarningStore.getSnapshot,
    foldWarningStore.getSnapshot,
  )
}
