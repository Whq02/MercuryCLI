#!/usr/bin/env bun
import { makeTally } from '../daemon/dupline-world.ts'
import { compatUsageReply } from './prove-compat-assistant-usage.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const tally = makeTally('prove-compat-reasoning-usage')
const rawUsage = (reasoning: number | undefined): Record<string, unknown> => ({
  prompt_tokens: 211,
  completion_tokens: 160,
  prompt_tokens_details: { cached_tokens: 41 },
  ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
})

for (const reasoning of [123, 0, undefined]) {
  const { frames, requests } = await compatUsageReply(rawUsage(reasoning), true)
  const result = frames.find(row => row.type === 'result')
  const details = result?.usage?.output_tokens_details as unknown as { thinking_tokens: number } | null | undefined
  console.log(JSON.stringify({ reasoning: reasoning ?? 'unstated', usage: result?.usage, model_usage: result?.model_usage }))
  tally.check('the compat fixture completes one headless request', requests === 1 && result?.subtype === 'success')
  tally.check('the result exposes the reasoning count in the existing SDK thinking field', reasoning === undefined ? details === null : details?.thinking_tokens === reasoning, JSON.stringify(details))
  tally.check('reasoning remains a subset of output, never an extra output charge', result?.usage?.output_tokens === 160 && Object.values(result.model_usage ?? {}).reduce((sum, row) => sum + row.output_tokens!, 0) === 160)
  tally.check('the input and cached-input counters remain disjoint', result?.usage?.input_tokens === 170 && result.usage.cache_read_input_tokens === 41)
}

const { decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { mapCompatUsageToAnthropic } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { accumulateUsage, updateUsage } = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')
const first = mapCompatUsageToAnthropic(decodeCompatUsage(rawUsage(123)))
const second = mapCompatUsageToAnthropic(decodeCompatUsage(rawUsage(7)))
const unstated = mapCompatUsageToAnthropic(decodeCompatUsage(rawUsage(undefined)))
const sum = accumulateUsage(first, second)
tally.check('normalization preserves the decoded reasoning subset', first.output_tokens_details?.thinking_tokens === 123)
tally.check('settled reasoning counts add across API messages', sum.output_tokens_details?.thinking_tokens === 130, JSON.stringify(sum.output_tokens_details))
tally.check('a later unstated counter does not erase known reasoning usage', accumulateUsage(sum, unstated).output_tokens_details?.thinking_tokens === 130)
tally.check('an entirely unstated reasoning count stays unknown', accumulateUsage(unstated, unstated).output_tokens_details === null)
tally.check('an explicit zero reasoning count stays a stated zero', accumulateUsage(unstated, mapCompatUsageToAnthropic(decodeCompatUsage(rawUsage(0)))).output_tokens_details?.thinking_tokens === 0)
tally.check('streaming cumulative details replace rather than add', updateUsage(first, second).output_tokens_details?.thinking_tokens === 7)
tally.check('accumulation never mutates a prior usage record', first.output_tokens_details?.thinking_tokens === 123 && second.output_tokens_details?.thinking_tokens === 7)
tally.finish()
