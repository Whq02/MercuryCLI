import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { countOpenDispatches } from '../../components/mercury-ui/scribeChatTabs.js'
import { isBatchApproved } from '../scribe/scribeBatchGate.js'

// ============================================================================
//  utils/hooks/scribeDispatchGate.ts — the SOURCE-side "one task at a time" gate.
// ----------------------------------------------------------------------------
//  The scribe pack *requests* "dispatch ONE at a time; supersede or batch, don't
//  stack". A prompt can only request it (and is summarizable away under context
//  pressure). This PreToolUse(SendMessage) hook ENFORCES it at the SOURCE: a normal-
//  priority `dispatch` is DENIED when one is already in flight, so the Scribe cannot
//  pile dispatches into the Implementer's inbox. Belt-and-suspenders with the daemon
//  bridge's DELIVERY back-pressure (#41 R1): the bridge guarantees one-at-a-time at
//  delivery; this stops the over-dispatch at the source so the doctrine survives a
//  summarized prompt or a custom system prompt.
//
//  SAFETY-POSITIVE: it only ever ADDS a hold to a NORMAL dispatch when work is in
//  flight. A priority:'high' (operator-queued) dispatch BYPASSES (the documented
//  escape), and every non-dispatch SendMessage (progress/escalate/control/plain text)
//  and every other tool passes straight through. Never bypasses any other gate.
// ============================================================================

/** Hook id so engage/disengage can remove exactly this hook. */
export const SCRIBE_DISPATCH_GATE_ID = 'scribe-dispatch-gate'

export interface DispatchGateVerdict {
  allow: boolean
  rule: 'not-a-dispatch' | 'batch-held' | 'high-priority-bypass' | 'in-flight-hold' | 'clear'
  reason: string
}

/**
 * Evaluate the source dispatch-gate. Pure + exported for the proof.
 *  - the pending SendMessage is not a `dispatch`        → allow (not our concern)
 *  - the operator DENIED the batch (/batch deny)        → DENY (explicit pause, even high-pri)
 *  - the dispatch is priority:'high' (operator-queued)  → allow (bypasses the in-flight hold)
 *  - a dispatch is already in flight (openInFlight > 0)  → DENY (one at a time)
 *  - otherwise                                           → allow
 *
 * The operator's `/batch deny` brake is checked FIRST (after the not-a-dispatch fast
 * path) so a paused batch holds ALL new dispatches — including a high-priority one —
 * until `/batch approve`. It only ever gates `dispatch` work; progress/escalate/control
 * coordination is never a dispatch, so a paused batch can't wedge the Scribe.
 */
export function evaluateDispatchGate(args: {
  messageType: string | undefined
  priority: string | undefined
  openInFlight: number
  batchApproved?: boolean
}): DispatchGateVerdict {
  if (args.messageType !== 'dispatch') {
    return { allow: true, rule: 'not-a-dispatch', reason: 'not a dispatch — pass' }
  }
  if (args.batchApproved === false) {
    return {
      allow: false,
      rule: 'batch-held',
      reason: 'the operator paused dispatching (/batch deny) — hold until /batch approve',
    }
  }
  if (args.priority === 'high') {
    return { allow: true, rule: 'high-priority-bypass', reason: 'priority:high (operator-queued) — bypasses the hold' }
  }
  if (args.openInFlight > 0) {
    return {
      allow: false,
      rule: 'in-flight-hold',
      reason: `${args.openInFlight} dispatch(es) already in flight — hold this one (one task at a time)`,
    }
  }
  return { allow: true, rule: 'clear', reason: 'no dispatch in flight — proceed' }
}

/** The deny re-prompt the model sees (leak-proof — never names the daemon/bus to the operator).
 *  Covers BOTH source holds: an in-flight dispatch (one-at-a-time) and the operator's /batch
 *  pause. The model just needs to not stack a dispatch; it keeps refining/relaying meanwhile.
 *
 *  The model-facing delivery prepends the standard `PreToolUse:SendMessage hook error:` framing
 *  (utils/hooks getPreToolHookBlockingMessage — shared by every PreToolUse hook, never reaches
 *  the operator). We lead with an explicit "internal coordination" line so that the standard prefix
 *  reads as the routine pacing gate it is, not a tool fault — this is the one spot the mechanism
 *  name would otherwise surface bare. */
export const SCRIBE_DISPATCH_GATE_REPROMPT =
  'Internal coordination (dispatch pacing — not a tool failure). ' +
  'Hold this dispatch — it cannot go out right now: either a task is already in flight (keep it ONE at a ' +
  'time) or the operator paused dispatching (a /batch hold). Instead of stacking another, SUPERSEDE the ' +
  'in-flight one (a new dispatch with refRequestId set to it) if this replaces it, BATCH this into the next ' +
  'dispatch once the current finishes, or wait. Keep refining and relaying meanwhile — the hold clears when ' +
  'the in-flight work reports back, or when the operator approves the batch. (A genuinely urgent ' +
  'operator-queued item may set priority:"high" to jump the in-flight hold; an operator /batch pause holds all.)'

/** Pull the pending SendMessage's structured message {type,priority} from PreToolUse hook input. */
function dispatchFromContext(hookInput: unknown): { messageType?: string; priority?: string } | null {
  if (
    hookInput == null ||
    typeof hookInput !== 'object' ||
    (hookInput as { hook_event_name?: string }).hook_event_name !== 'PreToolUse'
  ) {
    return null
  }
  const hi = hookInput as { tool_name?: string; tool_input?: { message?: unknown } }
  if (hi.tool_name !== SEND_MESSAGE_TOOL_NAME) return null
  const msg = hi.tool_input?.message
  if (msg == null || typeof msg !== 'object') return null // a plain-text message ⇒ not a dispatch
  const m = msg as { type?: unknown; priority?: unknown }
  return {
    messageType: typeof m.type === 'string' ? m.type : undefined,
    priority: typeof m.priority === 'string' ? m.priority : undefined,
  }
}

/**
 * Install the dispatch gate as a PreToolUse(SendMessage) function hook. The callback
 * reads the pending dispatch from the hook input + the in-flight count from the live
 * transcript (countOpenDispatches), so it holds a 2nd dispatch at the source. Scribe
 * process only (engageScribeHooks installs it).
 */
export function registerScribeDispatchGate(setAppState: SetAppState, sessionId: string): string {
  return addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    SEND_MESSAGE_TOOL_NAME,
    (messages, _signal, context) => {
      const pending = dispatchFromContext(context?.hookInput)
      if (pending === null) return true // not a structured SendMessage we can read → pass
      let openInFlight = 0
      try {
        openInFlight = countOpenDispatches(messages as readonly unknown[]).open
      } catch {
        openInFlight = 0 // never block on a parse failure
      }
      return evaluateDispatchGate({
        messageType: pending.messageType,
        priority: pending.priority,
        openInFlight,
        batchApproved: isBatchApproved(), // #47 /batch: the operator's explicit pause
      }).allow
    },
    SCRIBE_DISPATCH_GATE_REPROMPT,
    { timeout: 5000, id: SCRIBE_DISPATCH_GATE_ID },
  )
}

/** Remove the dispatch gate for a session. */
export function unregisterScribeDispatchGate(setAppState: SetAppState, sessionId: string): void {
  removeFunctionHook(setAppState, sessionId, 'PreToolUse', SCRIBE_DISPATCH_GATE_ID)
}
