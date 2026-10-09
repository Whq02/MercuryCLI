import { engageTurnGuard, hasTurnGuard } from './guards.js'
import { evaluateStopAttempt } from './runStopAdapter.js'

export const RUN_STOP_HOOK_ID = 'mercury-run-stop'

const MAX_BLOCKS = 3

export const RUN_STOP_HOOK_TIMEOUT_MS = 30_000

export function registerRunStopGuard(sessionId: string): string {
  if (hasTurnGuard(sessionId, RUN_STOP_HOOK_ID)) return RUN_STOP_HOOK_ID
  engageTurnGuard(sessionId, {
    id: RUN_STOP_HOOK_ID,
    timeoutMs: RUN_STOP_HOOK_TIMEOUT_MS,
    silent: true,
    judge: async ({ messages }, signal) => {
      try {
        await evaluateStopAttempt(messages, { maxBlocks: MAX_BLOCKS, wordingUnfinished: false, signal })
      } catch {
        return { hold: false }
      }
      return { hold: false }
    },
  })
  return RUN_STOP_HOOK_ID
}
