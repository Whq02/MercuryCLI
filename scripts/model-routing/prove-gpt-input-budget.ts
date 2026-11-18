import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'gpt-input-budget-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { gptDisplayPin, GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getModelInputCeiling } = await import('../../src/utils/model/capabilities.js')
const { getAutoCompactThreshold, getBlockingLimit } = await import('../../src/services/compact/autoCompact.js')

const stated = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']
const failures: string[] = []
let checks = 0
function check(label: string, run: () => void): void {
  checks++
  try { run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)}`) }
}
async function seed(body: Record<string, unknown>): Promise<void> {
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
}
try {
  check('the seven rows whose pages state "Maximum input tokens: 922,000" carry it, and no other row carries one', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.filter(pin => pin.maxInputTokens !== undefined).map(pin => pin.id), stated)
    for (const id of stated) assert.equal(gptDisplayPin(id)?.maxInputTokens, 922_000, id)
  })
  for (const id of stated) check(`${id} signed out: the window still reads 1,050,000 and the session compacts at 879,000, before the 922,000 input maximum, where it compacted at 1,007,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(getAutoCompactThreshold(id), 879_000)
    assert.equal(getBlockingLimit(id), 899_000)
  })
  check('a row whose page was not read for a maximum keeps the window as its budget: GPT-5.6 Sol compacts at 1,007,000', () => {
    assert.equal(getAutoCompactThreshold('gpt-5.6-sol'), 1_007_000)
  })
  check('the ceiling answers only for the window the row states: another window is returned as it is', () => {
    assert.equal(getModelInputCeiling('gpt-6.2-astra', 1_050_000), 922_000)
    assert.equal(getModelInputCeiling('gpt-6.2-astra', 2_100_000), 2_100_000)
    assert.equal(getModelInputCeiling('gpt-6.2-astra', 872_000), 872_000)
    assert.equal(getModelInputCeiling('gpt-5.6-sol', 1_050_000), 1_050_000)
    assert.equal(getModelInputCeiling('claude-fable-5-1', 1_000_000), 1_000_000)
  })
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  await seed({ data: stated.map(id => ({ id })) })
  for (const id of stated) check(`${id} on a bare API list: compaction at 879,000`, () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.equal(getAutoCompactThreshold(id), 879_000)
  })
  await seed({ models: stated.map((id, index) => ({ slug: id, visibility: 'list', priority: index + 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium', context_window: 272_000, max_context_window: 872_000, input_modalities: ['text', 'image'], supported_in_api: true })) })
  for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) check(`${id} on a list that states its own windows: the list decides, 872,000 with compaction at 829,000, and 272,000 with compaction at 229,000 on the served choice`, () => {
    assert.equal(getContextWindowForModel(id), 872_000)
    assert.equal(getAutoCompactThreshold(id), 829_000)
    assert.equal(getContextWindowForModel(`${id}[served]`), 272_000)
    assert.equal(getAutoCompactThreshold(`${id}[served]`), 229_000)
  })
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch still decides: 200,000 with compaction at 157,000', () => {
    assert.equal(getContextWindowForModel('gpt-6.2-astra'), 200_000)
    assert.equal(getAutoCompactThreshold('gpt-6.2-astra'), 157_000)
  })
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; "Maximum input tokens: 922,000" read 2026-11-17 on the seven model pages under https://developers.openai.com/api/docs/models/`)
process.exit(failures.length ? 1 : 0)
