
import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { evaluateStopAttempt } from './runStopAdapter.js'

export const RUN_STOP_HOOK_ID = 'mercury-run-stop'

const MAX_BLOCKS = 3

export const RUN_STOP_HOOK_TIMEOUT_MS = 30_000

const engagedSessions = new Set<string>()

export function _resetRunStopHookForTesting(): void {
  engagedSessions.clear()
}

export function registerRunStopHook(setAppState: SetAppState, sessionId: string): string {
  if (engagedSessions.has(sessionId)) return RUN_STOP_HOOK_ID
  engagedSessions.add(sessionId)
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    async (messages, signal) => {
      try {
        await evaluateStopAttempt(messages, {
          maxBlocks: MAX_BLOCKS,
          wordingUnfinished: false,
          signal,
          recordOnly: true,
        })
      } catch {
      }
      return true
    },
    'The run record was not updated at this stop',
    { timeout: RUN_STOP_HOOK_TIMEOUT_MS, id: RUN_STOP_HOOK_ID, silent: true },
  )
  return RUN_STOP_HOOK_ID
}
