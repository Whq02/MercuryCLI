
import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../../boot/process-state/processState.js'
import { getCwd } from '../../platform/files/cwd.js'

export function useCwdState(): string {
  return useSyncExternalStore(subscribeCwdState, getCwd, getCwd)
}
