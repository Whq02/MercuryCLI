import { IDLE_SPECULATION_STATE, type AppState, type SpeculationState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRecord } from '../../utils/isRecord.js'
import { logError } from '../../utils/log.js'
import type { CacheSafeParams } from '../agents/forkedAgent.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

const CLEARED_SUGGESTION: AppState['promptSuggestion'] = {
  text: null,
  promptId: null,
  shownAt: 0,
  acceptedAt: 0,
  generationRequestId: null,
}

function isActiveSpeculation(
  state: unknown,
): state is Extract<SpeculationState, { status: 'active' }> {
  return isRecord(state) && state.status === 'active'
}

export function clearPromptSuggestion(prev: AppState): AppState {
  if (prev.promptSuggestion.text === null) return prev
  return {
    ...prev,
    promptSuggestion: CLEARED_SUGGESTION,
  }
}

export function isSpeculationEnabled(): boolean {
  logForDebugging('speculation enabled: false')
  return false
}

export async function startSpeculation(
  _text: string,
  _context: unknown,
  _setAppState: SetAppState,
  _isPipelined?: boolean,
  _cacheSafeParams?: CacheSafeParams,
): Promise<void> {
  isSpeculationEnabled()
}

export function abortSpeculation(setAppState: SetAppState): void {
  setAppState(prev => {
    const current: unknown = prev.speculation
    if (!isActiveSpeculation(current)) return prev
    try {
      current.abort?.()
    } catch (error) {
      logForDebugging(`speculation abort thunk failed: ${String(error)}`)
    }
    return {
      ...prev,
      speculation: IDLE_SPECULATION_STATE,
    }
  })
}

export function handleSpeculationAccept(
  state: unknown,
  _sessionTimeSaved: number,
  setAppState: SetAppState,
  _input: string,
  _deps: unknown,
): { queryRequired: boolean } {
  if (!isActiveSpeculation(state)) {
    try {
      setAppState(clearPromptSuggestion)
    } catch (error) {
      logError(error)
    }
  }
  return { queryRequired: true }
}
