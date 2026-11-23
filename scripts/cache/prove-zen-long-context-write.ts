import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'zen-long-context-write-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENCODE_API_KEY', 'OPENAI_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { resolveModelPricing, calculateUSDCost } = await import('../../src/models/usage/modelCost.js')

const page = 'https://opencode.ai/docs/console/models/'
const written: Array<{ id: string; short: [number, number, number, number]; long: [number, number, number, number] }> = [
  { id: 'gpt-6.2-astra', short: [8, 0.4, 10, 40], long: [16, 0.8, 20, 60] },
  { id: 'gpt-6.2-sol', short: [2, 0.1, 2.5, 10], long: [4, 0.2, 5, 15] },
  { id: 'gpt-6-astra', short: [10, 1, 12.5, 50], long: [20, 2, 25, 75] },
  { id: 'gpt-6-sol', short: [2, 0.2, 2.5, 10], long: [4, 0.4, 5, 15] },
  { id: 'gpt-6.1-sol', short: [2, 0.1, 2.5, 10], long: [4, 0.2, 5, 15] },
  { id: 'gpt-6-luna', short: [0.1, 0.01, 0.125, 0.5], long: [0.2, 0.02, 0.25, 0.75] },
  { id: 'gpt-5.6-sol', short: [4, 0.4, 5, 20], long: [8, 0.8, 10, 30] },
  { id: 'gpt-5.6-terra', short: [2, 0.2, 2.5, 12], long: [4, 0.4, 5, 18] },
  { id: 'gpt-5.6-luna', short: [0.2, 0.02, 0.25, 1.2], long: [0.4, 0.04, 0.5, 1.8] },
]
const unwritten: Array<{ id: string; threshold: number; shortIn: number; longIn: number }> = [
  { id: 'gpt-5.5', threshold: 272_000, shortIn: 5, longIn: 10 },
  { id: 'gpt-5.4', threshold: 272_000, shortIn: 2.5, longIn: 5 },
  { id: 'grok-4.7', threshold: 200_000, shortIn: 2, longIn: 4 },
  { id: 'grok-4.6', threshold: 200_000, shortIn: 2, longIn: 4 },
  { id: 'grok-4.5', threshold: 200_000, shortIn: 2, longIn: 4 },
]
const failures: string[] = []
let checks = 0
function check(label: string, run: () => void): void {
  checks++
  try { run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)} | fix: the rows and their longContext tier (threshold, cacheWritePerMtok) are in src/models/facts/pins/zenPins.ts; the tier choice is in resolveModelPricing in src/models/usage/modelCost.ts; prices are those of ${page}`) }
}
function rates(id: string, promptTokens: number): [number, number, number, number] {
  const costs = resolveModelPricing(`zen/${id}`, { promptTokens }).costs
  return [costs.inputTokens, costs.promptCacheReadTokens, costs.promptCacheWriteTokens, costs.outputTokens]
}
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)
}
try {
  for (const row of written) check(`Zen ${row.id}: past 272,000 input tokens a cache write is the page's $${row.long[2]} a million, and the tier changes at more than 272,000`, () => {
    assert.deepEqual(rates(row.id, 300_000), row.long)
    assert.deepEqual(rates(row.id, 272_001), row.long)
    assert.deepEqual(rates(row.id, 272_000), row.short)
    assert.deepEqual(rates(row.id, 1_000), row.short)
  })
  for (const row of unwritten) check(`Zen ${row.id}: the page states no write rate for its long tier, the row holds none, and the tier changes at more than ${row.threshold.toLocaleString('en-US')}`, () => {
    assert.equal(rates(row.id, row.threshold)[0], row.shortIn)
    assert.equal(rates(row.id, row.threshold + 1)[0], row.longIn)
    assert.equal(rates(row.id, row.threshold + 1)[2], row.longIn)
  })
  check('a 300,000-token request with a 100,000-token cache write on Zen GPT 6.2 Astra: 3.2 + 2 + 0.06 = 5.26 USD, the write at $20 a million where it read $10', () => {
    near(calculateUSDCost('zen/gpt-6.2-astra', { input_tokens: 200_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 1_000 } as never), 5.26)
  })
  check('the same request on Zen GPT 6 Astra: 4 + 2.5 + 0.075 = 6.575 USD, the write at $25 a million where it read $12.50', () => {
    near(calculateUSDCost('zen/gpt-6-astra', { input_tokens: 200_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 1_000 } as never), 6.575)
  })
  check('a request of exactly 272,000 input tokens stays on the short tier: 1.376 + 1 + 0.04 = 2.416 USD on Zen GPT 6.2 Astra', () => {
    near(calculateUSDCost('zen/gpt-6.2-astra', { input_tokens: 172_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 1_000 } as never), 2.416)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; prices read 2026-11-17: ${page}`)
process.exit(failures.length ? 1 : 0)
