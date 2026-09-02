#!/usr/bin/env bun
// prove-usage-fold — #54: the headless result's usage must count
// SETTLED-path messages. The fold was stream-driven (message_stop only), so a
// message settling via the mid-stream fallback retraction / retry replay path
// never reached totalUsage — the P0 bench caught a ~19K-output-token Write
// reporting 925. Structural pins on the ONE owner (src/QueryEngine.ts):
//
//   §1 the settled-fold substrate exists (ids set · last-usage map · the
//      exact-once guard) and the fold skips stream-covered ids.
//   §2 the three collection points are wired: message_start stamps the id,
//      message_stop registers the stream fold, the assistant case records
//      the LAST yield's usage per id.
//   §3 every terminal envelope folds first: baseResult() opens with
//      foldSettledUsage() before reading totalUsage.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'QueryEngine.ts'),
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
check('stream-folded id set exists', src.includes('readonly #streamFoldedIds = new Set<string>()'))
check('settled last-usage map exists', src.includes('readonly #settledUsageById = new Map<string, NonNullableUsage>()'))
check(
  'fold is exact-once (the id is marked folded before its usage accumulates)',
  /for \(const \[messageId, usage\] of this\.#settledUsageById\) \{\s*if \(this\.#streamFoldedIds\.has\(messageId\)\) continue\s*this\.#streamFoldedIds\.add\(messageId\)/.test(src),
)
check(
  'fold skips stream-covered ids and empty usage',
  src.includes('if (this.#streamFoldedIds.has(messageId)) continue') &&
    src.includes('if (usage.input_tokens === 0 && usage.output_tokens === 0) continue'),
)
check(
  'fold accumulates through the shared usage helpers',
  src.includes('this.#accumulatedUsage = accumulateUsage(this.#accumulatedUsage, usage)') &&
    src.includes('updateUsage(EMPTY_USAGE, assistant.message.usage)'),
)

section('§2 collection points')
check(
  'message_start stamps the current stream message id',
  src.includes('currentStreamMessageId = streamEvent.message.id ?? null'),
)
check(
  'message_stop registers the stream fold for that id',
  /message_stop[\s\S]{0,600}this\.#streamFoldedIds\.add\(currentStreamMessageId\)/.test(src),
)
check(
  'the assistant case records the LAST usage per API message id',
  /this\.#settledUsageById\.set\(\s*providerMessageId,\s*updateUsage\(EMPTY_USAGE, assistant\.message\.usage\),\s*\)/.test(src),
)

section('§3 every terminal envelope folds first')
check(
  'the envelope builder folds the settled usage before reading the accumulated total',
  /const buildResultEnvelope = [\s\S]{0,400}?for \(const \[messageId, usage\] of this\.#settledUsageById\)[\s\S]{0,900}?usage: this\.#accumulatedUsage/.test(src),
)
check(
  'the envelope serves usage from the ONE accumulated total (single source)',
  src.includes('usage: this.#accumulatedUsage,') && !src.includes('usage: this.totalUsage'),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} USAGE-FOLD PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL USAGE-FOLD PROOFS PASS')
