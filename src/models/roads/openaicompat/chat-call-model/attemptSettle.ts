import { EMPTY_USAGE, usageCount } from '../../../../engine/request-parts/emptyUsage.js'
import {
  checkResponseForCacheBreak,
} from '../../../../engine/requests/promptCacheBreakDetection.js'
import {
  type CompatCompletedToolCall,
  type CompatFault,
  type CompatFinishReason,
  type CompatRuntimeReading,
  type CompatUsage,
} from '../compatChatClient.js'
import type { AssistantMessage } from '../../../../engine/message-shapes/message.js'
import { gateToolCalls, refusalAnswersAsToolResult, refusedCallInput } from '../../toolCallGate.js'
import type { CompatLaneProfile } from './lane.js'
import type { AttemptBlocks, CompatAttemptFinish } from './attemptBlocks.js'
import type { CompatAttemptCtx } from './attempt.js'

export function mapCompatUsageToAnthropic(usage: CompatUsage | undefined): typeof EMPTY_USAGE {
  const total = usageCount(usage?.inputTokens)
  const cached = Math.min(usageCount(usage?.cachedInputTokens), total)
  const written = Math.min(usageCount(usage?.cacheWriteInputTokens), total - cached)
  const oneHour = Math.min(usageCount(usage?.cacheWrite1hInputTokens), written)
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached - written),
    output_tokens: usageCount(usage?.outputTokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    cache_creation: { ephemeral_5m_input_tokens: written - oneHour, ephemeral_1h_input_tokens: oneHour },
    output_tokens_details: usage?.reasoningTokens !== undefined
      ? { thinking_tokens: usageCount(usage.reasoningTokens) }
      : null,
  }
}

const FINISH_TO_STOP: Record<CompatFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
  insufficient_system_resource: 'end_turn',
  network_error: 'end_turn',
  other: 'end_turn',
}

export function gateCompatToolCalls(ctx: CompatAttemptCtx, completed: CompatCompletedToolCall[], finish: CompatAttemptFinish | undefined) {
  const { tools } = ctx
  const accepted: Array<{ call: CompatCompletedToolCall; input: Record<string, unknown> }> = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.id,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
      ...(call.providerRefusal !== undefined ? { providerRefusal: call.providerRefusal } : {}),
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted },
  )
  const answered = new Set<CompatCompletedToolCall>()
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
    else if (finish?.reason !== 'length' && refusalAnswersAsToolResult(verdict.refusal)) answered.add(call)
  })
  return { accepted, verdicts, answered }
}

export function paintedCallsOf(
  w: Pick<AttemptBlocks, 'paintSlots' | 'minted' | 'mintBlock' | 'refusalNoteMessage'>,
  completed: CompatCompletedToolCall[],
  verdicts: ReturnType<typeof gateToolCalls>,
  answered: Set<CompatCompletedToolCall>,
): Set<CompatCompletedToolCall> {
  const { paintSlots, minted, mintBlock, refusalNoteMessage } = w
  const paintedCalls = new Set<CompatCompletedToolCall>()
  let inserted = 0
  for (const slot of paintSlots) {
    const at = completed.findIndex(entry => entry.index === slot.toolIndex && entry.id === slot.id && !paintedCalls.has(entry))
    if (at < 0) continue
    const call = completed[at]!
    const verdict = verdicts[at]!
    paintedCalls.add(call)
    let message: AssistantMessage
    if (verdict.ok) {
      message = mintBlock({ type: 'tool_use', id: call.id, name: call.name, input: verdict.input })
    } else if (answered.has(call)) {
      message = mintBlock({ type: 'tool_use', id: call.id, name: call.name, input: refusedCallInput(verdict.refusal) })
      refusalNoteMessage(verdict.refusal).decorate(message)
    } else {
      const refusal = refusalNoteMessage(verdict.refusal)
      message = mintBlock({ type: 'text', text: refusal.note, citations: null })
      refusal.decorate(message)
    }
    minted.splice(slot.at + inserted, 0, message)
    inserted += 1
  }
  paintSlots.length = 0
  return paintedCalls
}

export function terminationNoteOf(profile: CompatLaneProfile, finish: CompatAttemptFinish | undefined): string | undefined {
  switch (finish?.reason) {
    case 'content_filter':
      return `[${profile.lane}] the provider ended this response under its content filter — the turn is incomplete by provider policy, not finished.`
    case 'insufficient_system_resource':
      return `[${profile.lane}] the provider ended this response: insufficient system resources (a documented transient) — the turn was cut short by the provider, not finished; continue or retry as needed.`
    case 'network_error':
      return `[${profile.lane}] the provider ended this response with a network error — the turn was cut short by the provider, not finished.`
    case 'other':
      return `[${profile.lane}] the provider ended this response with an unmapped finish reason ('${finish?.rawReason ?? 'none stated'}') — the turn may be incomplete; continue or retry as needed.`
    default:
      return undefined
  }
}

type CompatUsageFacts = {
  finish: CompatAttemptFinish | undefined
  fault: CompatFault | undefined
  usageSeen: CompatUsage | undefined
  runtimeSeen: CompatRuntimeReading | undefined
  served: string | undefined
  accepted: Array<{ call: CompatCompletedToolCall; input: Record<string, unknown> }>
  answered: Set<CompatCompletedToolCall>
}

export function settleCompatUsage(ctx: CompatAttemptCtx, settleUsage: (faultCode?: string) => typeof EMPTY_USAGE, facts: CompatUsageFacts) {
  const { profile, options } = ctx
  const { finish, fault, usageSeen, runtimeSeen, served, accepted, answered } = facts
  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'stop'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 || answered.size > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = settleUsage(fault?.code)
  if (usageSeen !== undefined || runtimeSeen !== undefined) profile.noteRuntime?.({ runtime: runtimeSeen, usage: usageSeen, served })
  if (usageSeen) {
    void checkResponseForCacheBreak(
      options.querySource,
      finalUsage.cache_read_input_tokens,
      finalUsage.cache_creation_input_tokens ?? 0,
      ctx.messages,
      options.agentId,
      null,
    )
  }
  return { stopReason, finalUsage } as const
}
