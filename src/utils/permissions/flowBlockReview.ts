/**
 * The operator's answers to flow-blocked asks, and the denial-ledger write.
 *
 * In a session that can show a consent card, a flow-classifier block is that
 * card, never a machine deny. Two pieces of bookkeeping ride beside it:
 *   • an operator's "no" on the card holds for the rest of the TURN, keyed by
 *     the action (tool name + input): the same action blocked again is denied
 *     without a second card, and the model is told why. The memory hangs off
 *     the turn's AbortController — every submit creates a fresh one, so the
 *     next operator message starts clean and the card returns if the
 *     classifier blocks again;
 *   • an operator's "yes" ends the consecutive-block streak the ledger keeps,
 *     the way any allow does.
 * The ledger write lives here because the decision wrapper and the card
 * handlers both need it: an async subagent's setAppState goes nowhere, so
 * such contexts carry a local record updated by mutation; every other context
 * writes app state.
 */
import type { ToolUseContext } from '../../Tool.js'
import { type DenialTrackingState, recordSuccess } from './denialTracking.js'

const declinedByTurn = new WeakMap<AbortController, Set<string>>()

/** Serialise with object keys in sorted order, so two spellings of the same
 *  input agree on one key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** One action's identity for the decline memory: the tool plus its input. */
export function flowBlockActionKey(toolName: string, input: unknown): string {
  return `${toolName}\0${stableStringify(input)}`
}

/** Book the operator's "no" for this flow-blocked action, for this turn. */
export function recordOperatorDeclinedFlowBlock(
  context: ToolUseContext,
  toolName: string,
  input: unknown,
): void {
  const turn = context.abortController
  let keys = declinedByTurn.get(turn)
  if (!keys) {
    keys = new Set()
    declinedByTurn.set(turn, keys)
  }
  keys.add(flowBlockActionKey(toolName, input))
}

/** Whether the operator already declined this exact action this turn. */
export function operatorDeclinedFlowBlockThisTurn(
  context: ToolUseContext,
  toolName: string,
  input: unknown,
): boolean {
  return (
    declinedByTurn.get(context.abortController)?.has(flowBlockActionKey(toolName, input)) ??
    false
  )
}

/** Persist denial-ledger state to wherever this context keeps it. */
export function writeDenialState(
  context: ToolUseContext,
  next: DenialTrackingState,
): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, next)
    return
  }
  context.setAppState(prev => {
    // A no-change recordSuccess returns its input reference; answering with
    // prev keeps the store from waking its subscribers for nothing.
    if (prev.denialTracking === next) return prev
    return { ...prev, denialTracking: next }
  })
}

/** The operator allowed a flow-blocked action on the card: the
 *  consecutive-block streak ends, as it does on any allow. */
export function noteOperatorAllowedFlowBlock(context: ToolUseContext): void {
  const current = context.localDenialTracking ?? context.getAppState().denialTracking
  if (!current || current.consecutiveDenials === 0) return
  writeDenialState(context, recordSuccess(current))
}
