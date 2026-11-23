import { IDLE_SPECULATION_STATE, type AppState, type SpeculationState } from '../app-state/AppState.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { logError } from '../../platform/logs/errorLog.js'
import type { CacheSafeParams } from '../../crew/agents/forkedAgent.js'

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
  const enabled = false
  logForDebugging(`speculation enabled: ${enabled}`)
  return enabled
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
