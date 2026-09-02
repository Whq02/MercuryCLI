import type { ToolUseContext } from '../../Tool.js'
import { type DenialTrackingState, recordSuccess } from './denialTracking.js'

const declinedByTurn = new WeakMap<AbortController, Set<string>>()

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

export function flowBlockActionKey(toolName: string, input: unknown): string {
  return `${toolName}\0${stableStringify(input)}`
}

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

export function writeDenialState(
  context: ToolUseContext,
  next: DenialTrackingState,
): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, next)
    return
  }
  context.setAppState(prev => {
    if (prev.denialTracking === next) return prev
    return { ...prev, denialTracking: next }
  })
}

export function noteOperatorAllowedFlowBlock(context: ToolUseContext): void {
  const current = context.localDenialTracking ?? context.getAppState().denialTracking
  if (!current || current.consecutiveDenials === 0) return
  writeDenialState(context, recordSuccess(current))
}
