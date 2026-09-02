
import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'

export function useCwdState(): string {
  return useSyncExternalStore(subscribeCwdState, getCwd, getCwd)
}
