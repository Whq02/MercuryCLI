
import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import { isTabulaEnabled } from '../tabula/tabulaGates.js'
import { tabulaOnPromptSubmit, tabulaOnTurnStop } from '../tabula/fireTracker.js'
import { addFunctionHook } from './sessionHooks.js'

export const TABULA_FIRE_SUBMIT_HOOK_ID = 'tabula-fire-submit'
export const TABULA_FIRE_STOP_HOOK_ID = 'tabula-fire-stop'

const engagedSessions = new Set<string>()

export function resetTabulaFireEngagedSessionsForTest(): void {
  engagedSessions.clear()
}

function promptFromContext(hookInput: unknown): string | null {
  if (
    hookInput == null ||
    typeof hookInput !== 'object' ||
    (hookInput as { hook_event_name?: string }).hook_event_name !== 'UserPromptSubmit'
  ) {
    return null
  }
  const p = (hookInput as { prompt?: unknown }).prompt
  return typeof p === 'string' && p.trim() ? p : null
}

export function registerTabulaFireHooks(
  setAppState: SetAppState,
  sessionId: string,
): boolean {
  if (!isTabulaEnabled()) return false
  if (engagedSessions.has(sessionId)) return true
  addFunctionHook(
    setAppState,
    sessionId,
    'UserPromptSubmit',
    '',
    (_messages, _signal, context) => {
      try {
        if (!isTabulaEnabled()) return true
        const prompt = promptFromContext(context?.hookInput)
        if (prompt) tabulaOnPromptSubmit(prompt)
      } catch (e) {
        logForDebugging(`tabula fire submit observer failed: ${String(e)}`)
      }
      return true
    },
    'tabula fire observer (non-blocking)',
    { timeout: 5000, id: TABULA_FIRE_SUBMIT_HOOK_ID, silent: true },
  )
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    () => {
      try {
        if (isTabulaEnabled()) tabulaOnTurnStop()
      } catch (e) {
        logForDebugging(`tabula fire stop observer failed: ${String(e)}`)
      }
      return true
    },
    'tabula settle observer (non-blocking)',
    { timeout: 5000, id: TABULA_FIRE_STOP_HOOK_ID, silent: true },
  )
  engagedSessions.add(sessionId)
  return true
}
