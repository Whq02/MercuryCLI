// ============================================================================
//  TABULA fire hooks — the sent→worked→done observers (never blocking).
//
//  Two always-pass FunctionHooks wire the fire tracker into the session:
//   · UserPromptSubmit → tabulaOnPromptSubmit(prompt): expires stale
//     in-flight entries, fires armed notes the prompt carries verbatim.
//   · Stop → tabulaOnTurnStop(): a clean turn end settles fired notes as
//     done (via:'auto'). query.ts never reaches Stop hooks on aborts or API
//     errors, so an interrupted/failed turn can't settle anything.
//
//  Both callbacks return true unconditionally — pure observers, no re-prompt
//  is ever delivered, no loop-brake needed. Registered beside the wards hook
//  at the INTERACTIVE chokepoint only (REPL boot): arming happens exclusively
//  on the /tabula board's ↵, so headless/daemon sessions have nothing to
//  observe (the notepad doctrine — `-p` never touches it). Self-gating on
//  isTabulaEnabled(), idempotent per session (fixed ids + engaged-set).
// ============================================================================

import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import { isTabulaEnabled } from '../tabula/tabulaGates.js'
import { tabulaOnPromptSubmit, tabulaOnTurnStop } from '../tabula/fireTracker.js'
import { addFunctionHook } from './sessionHooks.js'

export const TABULA_FIRE_SUBMIT_HOOK_ID = 'tabula-fire-submit'
export const TABULA_FIRE_STOP_HOOK_ID = 'tabula-fire-stop'

const engagedSessions = new Set<string>()

/** TEST-ONLY: reset the per-session guard so proofs can re-register. */
export function resetTabulaFireEngagedSessionsForTest(): void {
  engagedSessions.clear()
}

/** The submitted prompt from a UserPromptSubmit hook input (else null). */
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

/**
 * Register the TABULA fire observers for a session. Self-gating: registers
 * nothing when the notepad is off. Idempotent per session.
 */
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
    '', // every user prompt
    (_messages, _signal, context) => {
      try {
        // Live re-read (authority-toggles rule): a mid-session kill honors.
        if (!isTabulaEnabled()) return true
        const prompt = promptFromContext(context?.hookInput)
        if (prompt) tabulaOnPromptSubmit(prompt)
      } catch (e) {
        logForDebugging(`tabula fire submit observer failed: ${String(e)}`)
      }
      return true // pure observer — the prompt always proceeds
    },
    'tabula fire observer (non-blocking)',
    // silent: an always-pass observer must not surface in the hook-progress
    // count ("Ran N stop-hook hooks"); a thrown error still lands as a
    // visible hook_error_during_execution attachment.
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
      return true // pure observer — never blocks a stop
    },
    'tabula settle observer (non-blocking)',
    { timeout: 5000, id: TABULA_FIRE_STOP_HOOK_ID, silent: true },
  )
  engagedSessions.add(sessionId)
  return true
}
