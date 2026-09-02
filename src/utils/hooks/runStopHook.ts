// ============================================================================
//  runStopHook — the DEFAULT Mercury run-evidence Stop hook (Sol 5.6
//  frontier sprint). Normal behavior, not a mode.
//
//  When the conversation has an ACTIVE SUBSTANTIVE run (it created work
//  items or landed mutations), a stop with open deliverables, a post-
//  mutation evidence gap, a failed/indeterminate mutating effect, or pending
//  IDE feedback is re-prompted ONCE per stop attempt (the continuation
//  latch) with the concrete next action — evidence-based, never wording-
//  based (wordingUnfinished is pinned false here: prose style alone never
//  triggers the default hook; that persistence posture belongs to the
//  opt-in fable/role hooks).
//
//  No active implementation run ⇒ the evaluator answers complete and the
//  hook is a pure pass-through — ordinary conversational behavior unchanged.
//  Registered by the REPL and QueryEngine at session boot (idempotent id).
// ============================================================================

import type { Message } from '../../types/message.js'
import { errorMessage } from '../errors.js'
import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { evaluateStopAttempt, repromptWithNextAction } from './runStopAdapter.js'
import { supervisorEnabled } from './supervisorGate.js'

export const RUN_STOP_HOOK_ID = 'mercury-run-stop'

/** Per-turn ceiling: the run hook may re-prompt at most this many times for
 *  one turn (shared with every other hook through the pooled latch count). */
const MAX_BLOCKS = 3

/** The supervisor's own evaluation deadline. Strictly under the hook's
 *  registered 30s ceiling: past THAT, the harness settles a hung callback as
 *  a silent 'cancelled'; past THIS, the supervisor throws its named error
 *  instead, which the hook executor surfaces as a visible notice while the
 *  stop proceeds. The evaluator is local-only (task-store folds, no model
 *  call, digests skipped), so ten seconds is pathology, never load. */
export const SUPERVISOR_EVALUATOR_DEADLINE_MS = 10_000

/** The hook executor's ceiling for this hook — the deadline above must sit
 *  strictly under it (prover-pinned relation). */
export const RUN_STOP_HOOK_TIMEOUT_MS = 30_000

export const RUN_STOP_REPROMPT =
  'Run-state check — never mention or explain this. The active run is not complete: ' +
  'finish the open work now with tool calls (act on the next concrete action below; retry ' +
  'after errors, gather missing info yourself). Never bypass a permission, approval, ' +
  'capability, or refusal gate. End the turn only when every in-scope deliverable is done ' +
  'and verified, or you are blocked on input only the operator can provide — then state ' +
  'the one blocker plainly. A deliverable that needs a capability, tool, or access you do ' +
  'not have is FINISHED by saying so: name the gap, hand off what remains, and end.'

/**
 * Evaluate one supervised stop attempt under the supervisor's OWN failure
 * posture: fail-open with a visible notice. The gate protects run-completion
 * honesty — a nudge, not a correctness boundary (block-correctness / warn the
 * rest) — so a broken or hung evaluator must never wedge a session's stops:
 * on an internal error or the deadline, this throws a supervisor-named error,
 * the hook executor converts the throw into a visible hook-error notice, and
 * the stop stands. A healthy evaluation maps the verdict onto the hook
 * contract (true = allow; string = the re-prompt).
 *
 * `evaluate` and `deadlineMs` are injectable for the posture prover; every
 * production call uses the real evaluator and the constant.
 */
export async function supervisedStopVerdict(
  messages: readonly Message[],
  signal: AbortSignal | undefined,
  evaluate: typeof evaluateStopAttempt = evaluateStopAttempt,
  deadlineMs: number = SUPERVISOR_EVALUATOR_DEADLINE_MS,
): Promise<true | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const verdict = await Promise.race([
      evaluate(messages, {
        maxBlocks: MAX_BLOCKS,
        wordingUnfinished: false, // evidence-only; prose never triggers this hook
        signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the run-completion supervisor timed out after ${Math.round(deadlineMs / 1000)}s — this stop proceeded unchecked`,
              ),
            ),
          deadlineMs,
        )
        timer.unref?.()
      }),
    ])
    if (verdict.allowStop) return true
    return repromptWithNextAction(RUN_STOP_REPROMPT, verdict.decision)
  } catch (error) {
    if (error instanceof Error && error.message.includes('run-completion supervisor')) throw error
    throw new Error(
      `the run-completion supervisor failed (${errorMessage(error)}) — this stop proceeded unchecked`,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Per-session engage guard (same contract as wardsHook's Set).
const engagedSessions = new Set<string>()

/** TEST-ONLY: reset the per-session guard. */
export function _resetRunStopHookForTesting(): void {
  engagedSessions.clear()
}

/**
 * Register the default run-evidence Stop hook for a session. Idempotent per
 * session; silent (the re-prompt reaches the model as an isMeta user message,
 * never painted in the transcript).
 */
export function registerRunStopHook(setAppState: SetAppState, sessionId: string): string {
  if (engagedSessions.has(sessionId)) return RUN_STOP_HOOK_ID
  engagedSessions.add(sessionId)
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // no matcher — every stop
    async (messages, signal) => {
      // The supervisor is opt-in (/supervisor or MERCURY_SUPERVISOR), read
      // live at every stop: off ⇒ never blocks, on ⇒ evidence check under
      // the supervisor's own deadline + fail-open posture. The gate governs
      // BLOCKING, not truth: even unchecked, the stop folds its decision
      // into the run record so a cleanly-finished run settles to a terminal
      // receipt — an 'active' sidecar left behind re-activates on every
      // resume. Silent fail-open: a record failure never wedges a stop.
      if (!supervisorEnabled()) {
        try {
          await evaluateStopAttempt(messages, {
            maxBlocks: MAX_BLOCKS,
            wordingUnfinished: false, // evidence-only; prose never triggers this hook
            signal,
            recordOnly: true,
          })
        } catch {
          /* the unchecked stop stands */
        }
        return true
      }
      return supervisedStopVerdict(messages, signal)
    },
    RUN_STOP_REPROMPT,
    { timeout: RUN_STOP_HOOK_TIMEOUT_MS, id: RUN_STOP_HOOK_ID, silent: true },
  )
  return RUN_STOP_HOOK_ID
}
