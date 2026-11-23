#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'usage-lanes-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { providerSessionSpend } = await import('../../src/models/roads/providerUsage.ts')
const { getModelUsage, resetCostState } = await import('../../src/boot/process-state/processState.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (inputTokens: number, outputTokens: number, costUSD: number) => ({
  inputTokens, outputTokens, costUSD, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 32_000,
})
const fixtures = [
  ['anthropic', 'claude-opus-5', 1000, 100, 0.5],
  ['openai', 'gpt-5.6-sol', 200, 20, 0.02],
  ['zai', 'glm-5.2', 300, 30, 0.03],
  ['moonshot', 'kimi-k3', 400, 40, 0.04],
  ['deepseek', 'deepseek-v4-pro', 500, 50, 0.05],
  ['xai', 'grok-4.7', 1200, 120, 0.12],
  ['meta', 'muse-spark-1.3', 1300, 130, 0.13],
  ['openai-compat', 'compat/qwen3-32b', 600, 60, 0],
  ['openrouter', 'openrouter/anthropic/claude-opus-5', 700, 70, 0.07],
  ['gemini', 'gemini-3-pro', 800, 80, 0.08],
  ['huggingface', 'huggingface/openai/gpt-oss-120b', 900, 90, 0.09],
  ['local', 'local/qwen3:8b', 1100, 110, 0],
] as const
try {
  resetCostState()
  for (const [, model, input, output, cost] of fixtures) getModelUsage()[model] = record(input, output, cost)
  for (const [route, , input, output, cost] of fixtures) {
    const spend = providerSessionSpend(route)
    check(`${route}: the usage owner partitions its own tokens and spend`, spend.models === 1 && spend.inputTokens === input && spend.outputTokens === output && spend.costUSD === cost, `${JSON.stringify(spend)}; fix spendForRoute in src/models/roads/provider-usage/spend.ts, or the model-to-route mapping declaredRouteOf in src/models/roads/routeLaw.ts`)
  }
  const ledgerIn = fixtures.reduce((sum, fixture) => sum + fixture[2], 0)
  const familiesIn = fixtures.reduce((sum, fixture) => sum + providerSessionSpend(fixture[0]).inputTokens, 0)
  check('every turn lands in one family: the families sum to the ledger', familiesIn === ledgerIn, `${familiesIn} of ${ledgerIn}; a model reaches no route or two routes, so check declaredRouteOf in src/models/roads/routeLaw.ts and spendForRoute in src/models/roads/provider-usage/spend.ts`)
  check('a Claude slug behind the OpenRouter carrier counts toward OpenRouter, never Anthropic', providerSessionSpend('anthropic').inputTokens === 1000 && providerSessionSpend('openrouter').inputTokens === 700, `anthropic ${providerSessionSpend('anthropic').inputTokens} (want 1000), openrouter ${providerSessionSpend('openrouter').inputTokens} (want 700); fix declaredRouteOf in src/models/roads/routeLaw.ts so an openrouter/ slug routes to openrouter`)
  resetCostState()
  getModelUsage()['claude-opus-5'] = record(10, 1, 0.01)
  getModelUsage()['gemini-3-pro'] = record(5, 1, 0.001)
  check('a lane with no turn has no invented model or spend', providerSessionSpend('openai').models === 0 && providerSessionSpend('openai').costUSD === 0, `${JSON.stringify(providerSessionSpend('openai'))}; spendForRoute in src/models/roads/provider-usage/spend.ts must count only models routed to the asked lane`)
  check('the active Gemini lane keeps its own tokens', providerSessionSpend('gemini').inputTokens === 5, `${JSON.stringify(providerSessionSpend('gemini'))}; fix the gemini route of declaredRouteOf in src/models/roads/routeLaw.ts or spendForRoute in src/models/roads/provider-usage/spend.ts`)
} finally {
  resetCostState()
  rmSync(home, { recursive: true, force: true })
}
console.log(`usage lane spend: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
