/**
 * Speculative execution of a prompt suggestion — pre-running the suggested
 * prompt in an isolated copy-on-write overlay while the user decides, so
 * accepting it is instant.
 *
 * THE ENABLEMENT PREDICATE IS FOLDED TO A CONSTANT FALSE in the audited
 * snapshot, so none of the speculative machinery can ever run. Under the
 * operator's drop-dead-machinery ruling (SCOPE-OUTS roster
 * extension over gate-dead lanes) this build carries the exported surface
 * and the disabled-world behaviour ONLY:
 *
 *   - `isSpeculationEnabled()` reports (and logs) false;
 *   - `startSpeculation` is a strict no-op while disabled — no overlay
 *     directory is created and no state changes;
 *   - `abortSpeculation` and `handleSpeculationAccept` handle the
 *     never-active state exactly as specified (identity state updates,
 *     fail-open `queryRequired: true`).
 *
 * The enabled-world lane (overlay isolation, the speculative tool policy
 * with its boundary taxonomy, the forked run, message preparation,
 * acceptance copy-back, pipelined suggestions) is deliberately NOT built.
 * Re-arming it is a
 * named operator decision, not a silent rebuild.
 */
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import type { PromptVariant } from './promptSuggestion.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

/** A stopped-speculation boundary: where and why the run paused/finished. */
export type CompletionBoundary = {
  type: string
  [key: string]: unknown
}

/**
 * The live-speculation record published into app state while a run is
 * active. The state slice is `{ status: 'idle' }` when nothing runs and
 * `{ status: 'active', ...ActiveSpeculationState }` while one does. The
 * message/written-path/context handles are LIVE refs shared with the
 * runner.
 */
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

/**
 * Folded to a constant false (and logs its own value at debug level, as the
 * audited snapshot does). The whole feature is a no-op while this is false.
 */
export function isSpeculationEnabled(): boolean {
  logForDebugging('speculation enabled: false')
  return false
}

/**
 * Start a speculation on a suggestion. While speculation is disabled this
 * is a strict no-op: no overlay directory is created and no state changes.
 */
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
  // The speculative lane is not built in this build (see the module header).
}

/**
 * Abort any active speculation. One state update; the previous state is
 * returned unchanged (by identity) when speculation is not active.
 */
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

/**
 * The accept journey. With speculation never active in this build, the
 * journey reduces to its guard: clear the prompt-suggestion state (returning
 * the previous state unchanged when it was already clear) and report that a
 * follow-up query is required so the user's message is processed normally.
 * Any exception fails open the same way.
 */
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
      // Clear the prompt-suggestion state; the previous state is returned
      // unchanged (by identity) when it was already clear.
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
    // Unreachable while the enablement predicate is folded false.
    return { queryRequired: true }
  } catch (error) {
    logError(error)
    return { queryRequired: true }
  }
}
