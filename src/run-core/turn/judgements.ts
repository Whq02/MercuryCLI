export const STREAM_FAULT_RECOVERY_LIMIT = 1

export const TOOL_CALL_REFUSAL_RECOVERY_LIMIT = 3

type StreamFaultDecision = { kind: 'continue'; attempt: number } | { kind: 'surface' }

export function decideToolCallRefusalRecovery(input: {
  refusals: number
  recoveryCount: number
}): StreamFaultDecision {
  if (input.refusals > 0 && input.recoveryCount < TOOL_CALL_REFUSAL_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

export const CUT_TOOL_CALL_RECOVERY_LIMIT = 2

export type CutToolCallDecision = { kind: 'retry'; attempt: number; outputTokens: number } | { kind: 'surface' }

export function decideCutToolCallRecovery(input: {
  recoveryCount: number
  sentCap: number | undefined
  cutAt: number
  upperLimit: number
  room: number
  routeTakesCap: boolean
}): CutToolCallDecision {
  if (!input.routeTakesCap || input.recoveryCount >= CUT_TOOL_CALL_RECOVERY_LIMIT) return { kind: 'surface' }
  if (![input.sentCap ?? 0, input.cutAt, input.upperLimit, input.room].every(Number.isFinite)) return { kind: 'surface' }
  const base = Math.max(input.sentCap ?? 0, input.cutAt, 1)
  const ceiling = Math.min(input.upperLimit, input.room > 0 ? input.room : input.upperLimit)
  const outputTokens = Math.min(base * 2, ceiling)
  if (outputTokens <= base) return { kind: 'surface' }
  return { kind: 'retry', attempt: input.recoveryCount + 1, outputTokens }
}

export const PAUSE_TURN_CONTINUATION_LIMIT = 8

export function decidePauseTurnContinuation(input: { continuations: number }): StreamFaultDecision {
  if (input.continuations < PAUSE_TURN_CONTINUATION_LIMIT) return { kind: 'continue', attempt: input.continuations + 1 }
  return { kind: 'surface' }
}

export const EMPTY_REPLY_RECOVERY_LIMIT = 1

const REASONING_ONLY_RECOVERY_LIMIT = 1

export const REASONING_CUT_RECOVERY_LIMIT = 2

export function decideReasoningOnlyRecovery(input: { recoveryCount: number; maxTokens: boolean }): StreamFaultDecision {
  const limit = input.maxTokens ? REASONING_CUT_RECOVERY_LIMIT : REASONING_ONLY_RECOVERY_LIMIT
  if (input.recoveryCount < limit) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

export function decideEmptyReplyRecovery(input: { recoveryCount: number }): StreamFaultDecision {
  if (input.recoveryCount < EMPTY_REPLY_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

export function decideStreamFaultRecovery(input: {
  continuableTail: boolean
  recoveryCount: number
}): StreamFaultDecision {
  if (input.continuableTail && input.recoveryCount < STREAM_FAULT_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}
