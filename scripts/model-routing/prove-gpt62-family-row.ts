import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'gpt62-family-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'NOUS_API_KEY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { GPT_DISPLAY_PINS } = await import('../../src/models/facts/pins/gptPins.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const { providerFrontierFact, openaiSessionDefault, openaiLightChoice } = await import('../../src/models/catalogue/providerFrontier.js')
const { effortFamiliesLabel } = await import('../../src/models/effort/effort.js')
const { ZEN_DISPLAY_PINS, zenDisplayPin, zenPinObservedAt, zenServedShapeOf, zenAcceptsEffort } = await import('../../src/models/facts/pins/zenPins.js')
const zenCatalogue = await import('../../src/models/roads/zen/zenCatalogue.js')
const { keyLanePins } = await import('../../src/models/catalogue/modelOptions.js')
const { NOUS_PORTAL_RECOMMENDED } = await import('../../src/models/roads/nous/nousCatalogue.js')
const { readModelListFacts } = await import('../../src/models/roads/typedModelIds.js')
const { resolveModelPricing } = await import('../../src/models/usage/modelCost.js')
const { getContextWindowForModel } = await import('../../src/engine/compaction-window/contextFill.js')
const { getModelMaxOutputTokens } = await import('../../src/models/facts/capabilities.js')

const astra = 'gpt-6.2-astra'
const sol = 'gpt-6.2-sol'
const ladder = ['low', 'medium', 'high', 'xhigh', 'max']
const zenRows = [
  { id: astra, name: 'GPT 6.2 Astra', short: [8, 0.4, 10, 40], long: { costInPerMtok: 16, costOutPerMtok: 60, cachedInPerMtok: 0.8, cacheWritePerMtok: 20 } },
  { id: sol, name: 'GPT 6.2 Sol', short: [2, 0.1, 2.5, 10], long: { costInPerMtok: 4, costOutPerMtok: 15, cachedInPerMtok: 0.2, cacheWritePerMtok: 5 } },
]
const failures: string[] = []
let checks = 0
function check(label: string, run: () => void): void {
  checks++
  try { run(); console.log(`PASS ${label}`) } catch (e) { failures.push(label); console.error(`FAIL ${label}: ${String(e)}`) }
}
try {
  check('the 6.2 release is the two models the provider lists, Sol first', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.map(pin => pin.id).filter(id => id.startsWith('gpt-6.2-')), [sol, astra])
  })
  check('the 6.2 rows lead the table and the rows before them keep their order', () => {
    assert.deepEqual(GPT_DISPLAY_PINS.slice(0, 7).map(pin => pin.id), [sol, astra, 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna'])
  })
  check('the family frontier is the first row of the newest release, GPT-6.2 Sol, and the session rule picks Sol of the two', () => {
    assert.deepEqual(providerFrontierFact('openai'), { modelId: sol, displayName: 'GPT-6.2 Sol', observedAt: '2026-11-17' })
    assert.equal(openaiSessionDefault([astra, sol])?.modelId, sol)
  })
  const frontierModule = await import('../../src/models/catalogue/providerFrontier.js') as Record<string, unknown>
  check('the frontier line no caller under src read is gone with what only it used: the module offers no such name, and a frontier fact carries a model, a name and at most a date', () => {
    assert.equal('providerFrontierLine' in frontierModule, false)
    assert.deepEqual(Object.keys(providerFrontierFact('openai') ?? {}), ['modelId', 'displayName', 'observedAt'])
    for (const route of ['xai', 'mistral', 'meta', 'deepseek', 'moonshot', 'zai', 'nous', 'minimax', 'cohere', 'qwen', 'huggingface'] as const) {
      const keys = Object.keys(providerFrontierFact(route) ?? {})
      assert.deepEqual(keys.filter(key => !['modelId', 'displayName', 'observedAt'].includes(key)), [], route)
    }
  })
  check('the light choice is the newest plain row under the 6.2 frontier, never a 6.2 row', () => {
    assert.equal(openaiLightChoice([astra, sol, 'gpt-5.5', 'gpt-5.4'], { major: 6, minor: 2 }), 'gpt-5.5')
    assert.equal(openaiLightChoice([astra, sol], { major: 6, minor: 2 }), undefined)
  })
  for (const id of [astra, sol]) check(`the effort ladder names the GPT family when ${id} alone serves a level`, () => {
    assert.equal(effortFamiliesLabel(probe => probe === id), 'GPT')
  })
  check('the typed OpenAI ids hold both 6.2 models', () => {
    const typed = readModelListFacts({} as NodeJS.ProcessEnv).find(fact => fact.family === 'openai')?.typed ?? []
    assert.ok(typed.includes(astra) && typed.includes(sol), typed.join(', '))
  })
  check('the Zen table lists both 6.2 rows first, as its page does', () => {
    assert.deepEqual(ZEN_DISPLAY_PINS.slice(0, 2).map(pin => pin.id), [astra, sol])
  })
  for (const row of zenRows) check(`the Zen row of ${row.id}: the page's name, the Responses shape, its prices and the 272,000 tier`, () => {
    const pin = zenDisplayPin(`zen/${row.id}`)
    assert.ok(pin, `src/models/facts/pins/zenPins.ts zenDisplayPin(zen/${row.id}) returned undefined`)
    assert.equal(pin.displayName, row.name)
    assert.equal(pin.shape, 'responses')
    assert.equal(zenServedShapeOf(`zen/${row.id}`), 'responses')
    assert.equal(pin.observedAt, '2026-11-17')
    assert.equal(pin.source, 'https://opencode.ai/docs/console/models/')
    assert.deepEqual([pin.costInPerMtok, pin.cachedInPerMtok, pin.cacheWritePerMtok, pin.costOutPerMtok], row.short)
    assert.equal(pin.longContextThreshold, 272_000)
    assert.deepEqual(pin.longContext, row.long)
    assert.deepEqual(pin.efforts, ladder)
    assert.equal(pin.images, true)
    assert.equal(zenAcceptsEffort(`zen/${row.id}`, 'max'), true)
    assert.equal(zenAcceptsEffort(`zen/${row.id}`, 'none'), false)
    assert.equal(zenAcceptsEffort(`zen/${row.id}`, 'minimal'), false)
  })
  for (const row of zenRows) check(`the Zen row of ${row.id} prices and budgets through the one owner`, () => {
    const p = resolveModelPricing(`zen/${row.id}`)
    assert.equal(p.basis, 'recorded')
    assert.deepEqual([p.costs.inputTokens, p.costs.promptCacheReadTokens, p.costs.promptCacheWriteTokens, p.costs.outputTokens], row.short)
    const long = resolveModelPricing(`zen/${row.id}`, { promptTokens: 272_001 }).costs
    assert.deepEqual([long.inputTokens, long.promptCacheReadTokens, long.promptCacheWriteTokens, long.outputTokens], [row.long.costInPerMtok, row.long.cachedInPerMtok, row.long.cacheWritePerMtok, row.long.costOutPerMtok])
    assert.equal(getContextWindowForModel(`zen/${row.id}`), 1_050_000)
    assert.deepEqual(getModelMaxOutputTokens(`zen/${row.id}`), { default: 128_000, upperLimit: 128_000 })
  })
  check('the Nous head holds one release of the family: the two 6.2 ids, GPT-6.1 Sol gone, five rows', () => {
    assert.deepEqual([...NOUS_PORTAL_RECOMMENDED], ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.2-astra', 'openai/gpt-6.2-sol', 'google/gemini-4-argon', 'deepseek/deepseek-v4.1-flash-1017'])
  })
  check("a ChatGPT sign-in's list wins over the row: its own effort words and default are sent, and a list that states none takes none from the row", () => {
    catalogue.__resetOpenaiCatalogueForTest()
    const now = Date.now()
    assert.equal(catalogue.primeOpenaiCatalogue({ sourceKind: 'chatgpt-subscription', fetchedAtMs: now, models: [sol, astra].map((id, index) => ({ id, priority: index + 1, supportedReasoningEfforts: ['low', 'medium'], reasoningEffortsStated: true, defaultReasoningEffort: 'low' })) }), true)
    for (const id of [sol, astra]) {
      const row = catalogue.evaluateGptCandidate(id, 'chatgpt-subscription')
      assert.ok(row.ok, id)
      assert.deepEqual(row.candidate.live.supportedReasoningEfforts, ['low', 'medium'])
      assert.equal(catalogue.resolveGptReasoningProfile('max', row.candidate.live).wireEffort, 'medium')
      assert.equal(catalogue.resolveGptReasoningProfile(undefined, row.candidate.live).wireEffort, 'low')
    }
    assert.equal(catalogue.primeOpenaiCatalogue({ sourceKind: 'chatgpt-subscription', fetchedAtMs: now + 1, models: [{ id: sol, supportedReasoningEfforts: [], reasoningEffortsStated: false }] }), true)
    const unstated = catalogue.evaluateGptCandidate(sol, 'chatgpt-subscription')
    assert.ok(unstated.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${sol}, chatgpt-subscription) failed when efforts unstated`)
    assert.deepEqual(unstated.candidate.live.supportedReasoningEfforts, [])
    assert.equal(catalogue.resolveGptReasoningProfile('max', unstated.candidate.live).wireEffort, undefined)
    catalogue.__resetOpenaiCatalogueForTest()
  })
  process.env.OPENCODE_API_KEY = 'fixture-key-not-real'
  zenCatalogue.__resetZenCatalogueForTest()
  const zenRead = await zenCatalogue.refreshZenCatalogue({ force: true, fetchImpl: (async () => new Response(JSON.stringify({ data: [astra, 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.5', 'kimi-k3'].map(id => ({ id })) }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  check("the Zen table's date has one owner that the picker reads: a row read on a later day shows its own date, a row with none the table's", () => {
    assert.ok(zenRead, 'the fixture list was not read')
    const shown = Object.fromEntries(keyLanePins('zen').map(row => [row.id, row.observedAt]))
    assert.deepEqual(shown, { 'zen/gpt-6.2-astra': '2026-11-17', 'zen/gpt-6-astra': '2026-11-18', 'zen/gpt-5.6-luna': '2026-11-18', 'zen/gpt-5.5': '2026-11-18', 'zen/kimi-k3': '2026-10-09' })
    for (const pin of ZEN_DISPLAY_PINS) assert.equal(zenPinObservedAt(pin), pin.observedAt ?? '2026-10-09', pin.id)
    assert.deepEqual(ZEN_DISPLAY_PINS.filter(pin => pin.maxInputTokens !== undefined || pin.longContext?.cacheWritePerMtok !== undefined).filter(pin => pin.observedAt === undefined).map(pin => pin.id), [])
  })
  zenCatalogue.__resetZenCatalogueForTest()
  delete process.env.OPENCODE_API_KEY
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; facts read 2026-11-17: https://developers.openai.com/api/docs/models; https://opencode.ai/docs/zen/; https://inference-api.nousresearch.com/v1/models`)
process.exit(failures.length ? 1 : 0)
