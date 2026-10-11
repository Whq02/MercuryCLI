import { IDLE_SPECULATION_STATE, type AppState, type SpeculationState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

type ActiveSpeculation = Extract<SpeculationState, { status: 'active' }>

const SPECULATION_ENABLED = false

const CLEARED_SUGGESTION: AppState['promptSuggestion'] = {
  text: null,
  promptId: null,
  shownAt: 0,
  acceptedAt: 0,
  generationRequestId: null,
}

const isActive = (state: unknown): state is ActiveSpeculation =>
  typeof state === 'object' && state !== null && (state as { status?: unknown }).status === 'active'

function stopQuietly(active: ActiveSpeculation): void {
  try {
    active.abort()
  } catch (error) {
    logForDebugging(`speculation abort thunk failed: ${String(error)}`)
  }
}

export function clearPromptSuggestion(prev: AppState): AppState {
  return prev.promptSuggestion.text === null ? prev : { ...prev, promptSuggestion: CLEARED_SUGGESTION }
}

export function isSpeculationEnabled(): boolean {
  logForDebugging(`speculation enabled: ${SPECULATION_ENABLED}`)
  return SPECULATION_ENABLED
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
    if (!isActive(prev.speculation)) return prev
    stopQuietly(prev.speculation)
    return { ...prev, speculation: IDLE_SPECULATION_STATE }
  })
}

export function handleSpeculationAccept(
  state: unknown,
  _sessionTimeSaved: number,
  setAppState: SetAppState,
  _input: string,
  _deps: unknown,
): { queryRequired: boolean } {
  try {
    if (!isActive(state)) setAppState(clearPromptSuggestion)
  } catch (error) {
    logError(error)
  }
  return { queryRequired: true }
}
