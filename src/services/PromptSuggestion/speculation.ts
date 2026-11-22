import type { AppState } from '../../state/AppState.js'
import type { CacheSafeParams } from '../agents/forkedAgent.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type SetAppState = (...args: Unbuilt[]) => Unbuilt

export function clearPromptSuggestion(prev: AppState): AppState {
  return notBuilt('src/services/PromptSuggestion/speculation.ts:31')
}

export function isSpeculationEnabled(): boolean {
  return notBuilt('src/services/PromptSuggestion/speculation.ts:35')
}

export async function startSpeculation(
  _text: string,
  _context: unknown,
  _setAppState: SetAppState,
  _isPipelined?: boolean,
  _cacheSafeParams?: CacheSafeParams,
): Promise<void> {
  return notBuilt('src/services/PromptSuggestion/speculation.ts:40')
}

export function abortSpeculation(setAppState: SetAppState): void {
  return notBuilt('src/services/PromptSuggestion/speculation.ts:50')
}

export function handleSpeculationAccept(
  state: unknown,
  _sessionTimeSaved: number,
  setAppState: SetAppState,
  _input: string,
  _deps: unknown,
): { queryRequired: boolean } {
  return notBuilt('src/services/PromptSuggestion/speculation.ts:58')
}
