#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'rows', 'turn.ts'),
  'utf8',
)
let failures = 0
const check = (label: string, cond: boolean): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) failures++
}
const section = (t: string): void =>
  console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 settled-fold substrate')
check('stream-folded id set exists', src.includes('private readonly streamFoldedIds = new Set<string>()'))
check('settled last-usage map exists', src.includes('private readonly settledUsageById = new Map<string, NonNullableUsage>()'))
check(
  'fold is exact-once (the id is marked folded before its usage accumulates)',
  /for \(const \[messageId, usage\] of this\.settledUsageById\) \{\s*if \(this\.streamFoldedIds\.has\(messageId\)\) continue\s*this\.streamFoldedIds\.add\(messageId\)/.test(src),
)
check(
  'fold skips stream-covered ids and empty usage',
  src.includes('if (this.streamFoldedIds.has(messageId)) continue') &&
    src.includes('if (usage.input_tokens === 0 && usage.output_tokens === 0) continue'),
)
check(
  'fold accumulates through the shared usage helpers',
  src.includes('this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, usage)') &&
    src.includes('updateUsage(EMPTY_USAGE, assistant.message.usage)'),
)

section('§2 collection points')
check(
  'message_start stamps the current stream message id',
  src.includes('currentStreamMessageId = streamEvent.message.id ?? null'),
)
check(
  'message_stop registers the stream fold for that id',
  /message_stop[\s\S]{0,600}this\.streamFoldedIds\.add\(currentStreamMessageId\)/.test(src),
)
check(
  'the assistant case records the LAST usage per API message id',
  /const usage = updateUsage\(EMPTY_USAGE, assistant\.message\.usage\)\s*this\.settledUsageById\.set\(providerMessageId, usage\)/.test(src),
)

section('§3 every outcome folds first')
check(
  "the outcome's facts fold settled reasoning usage before reading its total",
  /const outcomeFactsOf = [\s\S]*?for \(const \[messageId, usage\] of this\.settledUsageById\)[\s\S]*?output_tokens_details: this\.accumulatedUsage\.output_tokens_details/.test(src),
)
check(
  'the outcome bills input, output and cache from the same turn delta as its models',
  src.includes('const billed = usageSince(getModelUsage(), modelUsageAtStart)') &&
    src.includes('const usage = Object.values(billed).reduce(') &&
    ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].every(key => src.includes(`+ row.${key}`)) &&
    /usage,\s*models: modelUsageRows\(billed,/.test(src),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} USAGE-FOLD PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL USAGE-FOLD PROOFS PASS')
