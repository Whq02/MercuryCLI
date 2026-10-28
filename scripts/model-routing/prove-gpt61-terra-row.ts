import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'terra-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { gptDisplayPin, GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getModelMaxOutputTokens, modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.js')
const { resolveEffortTruth, resolveStampedEffortTruth } = await import('../../src/utils/effort.js')
const { getModelOptions, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
const { resolveModelPricing } = await import('../../src/utils/modelCost.js')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.js')
const { buildOpenaiResponsesRequest, openaiEffortWireFact } = await import('../../src/services/providers/openai/responsesBridge.js')

const id = 'gpt-6.1-terra'
const source = 'https://developers.openai.com/api/docs/models/gpt-6.1-terra'
const words = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const failures: string[] = []
let checks = 0
function check(name: string, run: () => void): void {
  checks++
  try { run(); console.log(`PASS ${name}`) } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${String(e)}`) }
}
async function seed(rows: Record<string, unknown>[]): Promise<void> {
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
}
try {
  check('dated Terra model-page pin', () => {
    const pin = gptDisplayPin(id)
    assert.ok(pin)
    assert.equal(pin.source, source)
    assert.equal(pin.observedAt, '2026-10-28')
    assert.equal(pin.displayName, 'GPT-6.1 Terra')
    assert.equal(pin.contextWindow, 1_050_000)
    assert.equal(pin.outputMax, 128_000)
    assert.equal(pin.knowledgeCutoff, '2026-06-01')
  })
  check('pin sits after the sibling Sol tier', () => assert.equal(GPT_DISPLAY_PINS[GPT_DISPLAY_PINS.findIndex(p => p.id === 'gpt-6.1-sol') + 1]?.id, id))
  check('cold context and output read the page, not family defaults', () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.deepEqual(getModelMaxOutputTokens(id), { default: 128_000, upperLimit: 128_000 })
  })
  check('four Standard rates and long-context tier', () => {
    const p = resolveModelPricing(id)
    assert.equal(p.basis, 'recorded')
    assert.deepEqual([p.costs.inputTokens, p.costs.promptCacheReadTokens, p.costs.promptCacheWriteTokens, p.costs.outputTokens], [1, 0.05, 1.25, 5])
    const long = resolveModelPricing(id, { promptTokens: 272_001 }).costs
    assert.deepEqual([long.inputTokens, long.promptCacheReadTokens, long.promptCacheWriteTokens, long.outputTokens], [2, 0.1, 2.5, 7.5])
  })
  check('native tool-search form', () => assert.equal(deferralWireFormFor(id, { env: {}, probeVerdict: () => undefined }).form, 'openai-native'))
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  await seed([{ id: 'gpt-6.1-sol', priority: 1 }, { id, priority: 2 }])
  check('bare API list inherits documented vocabulary and modalities', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, words)
    assert.equal(row.candidate.live.defaultReasoningEffort, 'medium')
    assert.deepEqual(row.candidate.live.inputModalities, ['text', 'image'])
    assert.ok(modelReceivesImageBlocks(id))
  })
  check('picker uses live rank and the model-page name', () => {
    const rows = getModelOptions()
    const row = rows.find(r => r.value === id)
    assert.ok(row)
    assert.equal(row.label, 'GPT-6.1 Terra')
    assert.equal(row.group, OPENAI_MODEL_GROUP)
    assert.equal(row.unavailable, undefined)
    assert.ok(rows.findIndex(r => r.value === id) > rows.findIndex(r => r.value === 'gpt-6.1-sol'))
  })
  for (const word of words) check(`request preserves ${word}`, () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok)
    const profile = catalogue.resolveGptReasoningProfile(word, row.candidate.live)
    const request = buildOpenaiResponsesRequest({ model: id, messages: [{ role: 'user', content: 'Reply OK.' }], reasoningEffort: profile.wireEffort })
    assert.equal(request.reasoning?.effort, word)
    assert.deepEqual(openaiEffortWireFact(request, true), { kind: 'sent', parameter: 'reasoning.effort', value: word })
    if (word !== 'none') {
      const asked = word as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      assert.equal(resolveEffortTruth(id, asked).label, word)
      assert.equal(resolveStampedEffortTruth(id, asked).wire, word)
    }
  })
  check('documented default and sibling vocabulary', () => {
    assert.equal(resolveEffortTruth(id, undefined).wire, 'medium')
    const sibling = catalogue.evaluateGptCandidate('gpt-6.1-sol', 'api-key')
    assert.ok(sibling.ok)
    assert.deepEqual(sibling.candidate.live.supportedReasoningEfforts, words.slice(1))
  })
  await seed([{ id, supported_reasoning_levels: [], input_modalities: ['text'], context_window: 272_000, max_context_window: 872_000 }])
  check('explicit source facts outrank page fallback', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, [])
    assert.deepEqual(row.candidate.live.inputModalities, ['text'])
    assert.equal(getContextWindowForModel(id), 872_000)
    assert.equal(getContextWindowForModel(`${id}[served]`), 272_000)
  })
  await seed([{ id: 'gpt-6.1-sol' }])
  check('pin never admits an unlisted model', () => assert.equal(catalogue.evaluateGptCandidate(id, 'api-key').ok, false))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; facts read 2026-10-28: ${source}; https://developers.openai.com/api/docs/models/gpt-6.1-sol`)
process.exit(failures.length ? 1 : 0)
