import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { countOpenDispatches } from '../../components/mercury-ui/scribeChatTabs.js'
import { isBatchApproved } from '../scribe/scribeBatchGate.js'


export const SCRIBE_DISPATCH_GATE_ID = 'scribe-dispatch-gate'

export interface DispatchGateVerdict {
  allow: boolean
  rule: 'not-a-dispatch' | 'batch-held' | 'high-priority-bypass' | 'in-flight-hold' | 'clear'
  reason: string
}

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

export const SCRIBE_DISPATCH_GATE_REPROMPT =
  'Internal coordination (dispatch pacing — not a tool failure). ' +
  'Hold this dispatch — it cannot go out right now: either a task is already in flight (keep it ONE at a ' +
  'time) or the operator paused dispatching (a /batch hold). Instead of stacking another, SUPERSEDE the ' +
  'in-flight one (a new dispatch with refRequestId set to it) if this replaces it, BATCH this into the next ' +
  'dispatch once the current finishes, or wait. Keep refining and relaying meanwhile — the hold clears when ' +
  'the in-flight work reports back, or when the operator approves the batch. (A genuinely urgent ' +
  'operator-queued item may set priority:"high" to jump the in-flight hold; an operator /batch pause holds all.)'

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
  if (msg == null || typeof msg !== 'object') return null
  const m = msg as { type?: unknown; priority?: unknown }
  return {
    messageType: typeof m.type === 'string' ? m.type : undefined,
    priority: typeof m.priority === 'string' ? m.priority : undefined,
  }
}

export function registerScribeDispatchGate(setAppState: SetAppState, sessionId: string): string {
  return addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    SEND_MESSAGE_TOOL_NAME,
    (messages, _signal, context) => {
      const pending = dispatchFromContext(context?.hookInput)
      if (pending === null) return true
      let openInFlight = 0
      try {
        openInFlight = countOpenDispatches(messages as readonly unknown[]).open
      } catch {
        openInFlight = 0
      }
      return evaluateDispatchGate({
        messageType: pending.messageType,
        priority: pending.priority,
        openInFlight,
        batchApproved: isBatchApproved(),
      }).allow
    },
    SCRIBE_DISPATCH_GATE_REPROMPT,
    { timeout: 5000, id: SCRIBE_DISPATCH_GATE_ID },
  )
}

export function unregisterScribeDispatchGate(setAppState: SetAppState, sessionId: string): void {
  removeFunctionHook(setAppState, sessionId, 'PreToolUse', SCRIBE_DISPATCH_GATE_ID)
}
