import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import type { PromptVariant } from './promptSuggestion.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

export type CompletionBoundary = {
  type: string
  [key: string]: unknown
}

export type ActiveSpeculationState = {
  id: string
  abort: () => void
  startTime: number
  messagesRef: { current: unknown[] }
  writtenPathsRef: { current: Set<string> }
  boundary: CompletionBoundary | null
  suggestionLength: number
  toolUseCount: number
  isPipelined: boolean
  contextRef: { current: REPLHookContext }
  pipelinedSuggestion?: {
    text: string
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
}

export function isSpeculationEnabled(): boolean {
  logForDebugging('speculation enabled: false')
  return false
}

export async function startSpeculation(
  text: string,
  context: unknown,
  setAppState: SetAppState,
  isPipelined?: boolean,
  cacheSafeParams?: CacheSafeParams,
): Promise<void> {
  void text
  void context
  void setAppState
  void isPipelined
  void cacheSafeParams
  if (!isSpeculationEnabled()) return
}

export function abortSpeculation(setAppState: SetAppState): void {
  setAppState(prev => {
    const speculation = (prev as { speculation?: { status?: string } }).speculation
    if (speculation?.status !== 'active') return prev
    const active = speculation as unknown as Partial<ActiveSpeculationState>
    try {
      active.abort?.()
    } catch (error) {
      logForDebugging(`speculation abort thunk failed: ${String(error)}`)
    }
    return { ...prev, speculation: IDLE_SPECULATION_STATE } as AppState
  })
}

export function handleSpeculationAccept(
  state: unknown,
  sessionTimeSaved: number,
  setAppState: SetAppState,
  input: string,
  deps: unknown,
): { queryRequired: boolean } {
  void sessionTimeSaved
  void input
  void deps
  try {
    const speculation = (state as { status?: string } | null | undefined) ?? undefined
    if (speculation?.status !== 'active') {
      setAppState(prev => {
        if (prev.promptSuggestion.text === null) return prev
        return {
          ...prev,
          promptSuggestion: {
            text: null,
            promptId: null,
            shownAt: 0,
            acceptedAt: 0,
            generationRequestId: null,
          },
        }
      })
      return { queryRequired: true }
    }
    return { queryRequired: true }
  } catch (error) {
    logError(error)
    return { queryRequired: true }
  }
}
