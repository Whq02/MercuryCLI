import type { NonNullableUsage } from '../../engine/request-parts/emptyUsage.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import { EMPTY_USAGE } from '../../engine/request-parts/emptyUsage.js'
import { roughTokenCountEstimation } from '../facts/tokenEstimation.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function streamedCharsOf(minted: ReadonlyArray<Pick<AssistantMessage, 'message'>>): number {
  let chars = 0
  for (const m of minted) {
    const content: unknown = m.message.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') chars += block.text.length
      if (typeof block.thinking === 'string') chars += block.thinking.length
      if (block.type === 'tool_use' && block.input !== undefined) chars += JSON.stringify(block.input).length
    }
  }
  return chars
}

function safeStringifyLength(value: unknown): number {
  const seen = new WeakSet<object>()
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })?.length ?? 0
  )
}

function requestCharsOf(request: unknown): number {
  try {
    return JSON.stringify(request)?.length ?? 0
  } catch {
    try {
      return safeStringifyLength(request)
    } catch (error) {
      passedOver(error)
      logForDebugging(`faultUsageEstimate: request could not be serialized for token estimate (${String(error)})`)
      return 0
    }
  }
}

export function estimateFaultedRequestUsage(args: {
  lane: string
  model: string
  request: unknown
  minted: ReadonlyArray<Pick<AssistantMessage, 'message'>>
  faultCode: string
}): NonNullableUsage {
  const input = roughTokenCountEstimation(' '.repeat(requestCharsOf(args.request)))
  const output = roughTokenCountEstimation(' '.repeat(streamedCharsOf(args.minted)))
  logForDebugging(
    `[${args.lane}] the stream ended (${args.faultCode}) with no usage frame — settling ${args.model} into the ledger at the character estimate (≈${input} in / ≈${output} out) rather than zero`,
  )
  return { ...EMPTY_USAGE, input_tokens: input, output_tokens: output, usage_source: 'estimated' }
}
