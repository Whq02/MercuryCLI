#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-cost-lane-lines.ts — /cost names EVERY family's
//  session spend, partitioned by the routing law and labelled by the one
//  display-name table (no hand-kept subset).
//
//    §1 a ledger with turns on nine engine lanes yields nine lane lines,
//       each labelled with the family's display name and its own tokens
//    §2 a lane that ran nothing gets no line (never a fabricated zero)
//    §3 the OpenAI line still rides the per-provider facade (subscription
//       vs key wording)
//    §4 a Claude slug behind the carrier counts toward OpenRouter, never
//       Anthropic (the routing law partitions, not the slug's words)
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-cost-lane-lines.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-cost-lanes-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { nonAnthropicLaneLines } = await import('../../src/commands/cost/cost.ts')

const record = (inputTokens: number, outputTokens: number, costUSD: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
})
const usage = {
  'claude-opus-5': record(1000, 100, 0.5),
  'gpt-5.6-sol': record(200, 20, 0.02),
  'glm-5.2': record(300, 30, 0.03),
  'kimi-k3': record(400, 40, 0.04),
  'deepseek-v4-pro': record(500, 50, 0.05),
  'compat/qwen3-32b': record(600, 60, 0),
  'openrouter/anthropic/claude-opus-5': record(700, 70, 0.07),
  'gemini-3-pro': record(800, 80, 0.08),
  'huggingface/openai/gpt-oss-120b': record(900, 90, 0.09),
  'local/qwen3:8b': record(1100, 110, 0),
} as never
const openaiView = () =>
  ({
    provider: 'openai',
    entries: [],
    activeEntry: { id: 'openai:api-key', provider: 'openai', kind: 'api-key', label: 'OpenAI API key (env)' },
    sessionSpend: { inputTokens: 200, outputTokens: 20, costUSD: 0.02, models: 1 },
    limits: { kind: 'openai-observed', window: { state: 'clear' } },
  }) as never

console.log('============================================================')
console.log(' /cost — every family\'s lane line')
console.log('============================================================')

const lines = nonAnthropicLaneLines({ usage: () => usage, openaiView })
const expectLine = (label: string, pattern: RegExp): void =>
  check(`${label} line present with its own tokens`, lines.some(l => pattern.test(l)), JSON.stringify(lines))
expectLine('OpenAI (facade wording)', /^OpenAI \(OpenAI API key \(env\)\): 200 in · 20 out — /)
expectLine('Z.AI', /^Z\.AI: 300 in · 30 out/)
expectLine('Moonshot', /^Moonshot: 400 in · 40 out/)
expectLine('DeepSeek', /^DeepSeek: 500 in · 50 out/)
expectLine('Custom endpoint (no cost ⇒ no USD tail)', /^Custom endpoint: 600 in · 60 out$/)
expectLine('OpenRouter (the carrier slug counts here, never Anthropic)', /^OpenRouter: 700 in · 70 out/)
expectLine('Gemini', /^Gemini: 800 in · 80 out/)
expectLine('Hugging Face', /^Hugging Face: 900 in · 90 out/)
expectLine('Local models (keyless ⇒ no USD tail)', /^Local models: 1,100 in · 110 out$/)
check('exactly nine lane lines — one per engine family that ran', lines.length === 9, String(lines.length))
check('the Anthropic ledger row never becomes a lane line (the subscriber/pool sentence owns it)', !lines.some(l => /^Anthropic/.test(l)))

const quiet = nonAnthropicLaneLines({
  usage: () => ({ 'claude-opus-5': record(10, 1, 0.01), 'gemini-3-pro': record(5, 1, 0.001) }) as never,
  openaiView: () => ({ ...(openaiView() as object), sessionSpend: { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 } }) as never,
})
check('lanes that ran nothing get no line (only Gemini here)', quiet.length === 1 && /^Gemini: 5 in · 1 out/.test(quiet[0] ?? ''), JSON.stringify(quiet))

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
