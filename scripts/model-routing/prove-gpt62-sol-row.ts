import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'gpt62-sol-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { gptDisplayPin, gptDisplayName, parseGptModelId, GPT_DISPLAY_PINS } = await import('../../src/models/facts/pins/gptPins.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const { getContextWindowForModel } = await import('../../src/engine/compaction-window/contextFill.js')
const { getModelMaxOutputTokens, modelReceivesImageBlocks } = await import('../../src/models/facts/capabilities.js')
const { getModelOptions, OPENAI_MODEL_GROUP } = await import('../../src/models/catalogue/modelOptions.js')
const { getPublicModelDisplayName, renderModelName } = await import('../../src/models/catalogue/engineModel.js')
const { resolveModelPricing, getModelPricingString, calculateUSDCost } = await import('../../src/models/usage/modelCost.js')
const { deferralWireFormFor } = await import('../../src/models/roads/deferralWire.js')
const { buildOpenaiResponsesRequest, openaiEffortWireFact } = await import('../../src/models/roads/openai/responsesBridge.js')
const { openaiCacheRetention } = await import('../../src/models/roads/openai/openaiCacheRetention.js')

const id = 'gpt-6.2-sol'
const sibling = 'gpt-6.2-astra'
const name = 'GPT-6.2 Sol'
const source = 'https://developers.openai.com/api/docs/models/gpt-6.2-sol'
const listed = ['low', 'medium', 'high', 'xhigh', 'max']
const asked = ['none', 'minimal', ...listed]
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
function requestFor(effort: string | undefined) {
  return buildOpenaiResponsesRequest({ model: id, messages: [{ role: 'user', content: 'Reply OK.' }], ...(effort !== undefined ? { reasoningEffort: effort } : {}) })
}
try {
  check('dated model-page pin: the window, the output ceiling, the input kinds and the cutoff the page states', () => {
    const pin = gptDisplayPin(id)
    assert.ok(pin, `src/models/facts/pins/gptPins.ts gptDisplayPin(${id}) returned undefined`)
    assert.equal(pin.source, source)
    assert.equal(pin.observedAt, '2026-11-17')
    assert.equal(pin.displayName, name)
    assert.equal(pin.contextWindow, 1_050_000)
    assert.equal(pin.outputMax, 128_000)
    assert.deepEqual(pin.inputModalities, ['text', 'image'])
    assert.equal(pin.knowledgeCutoff, '2026-06-01')
    assert.equal(pin.availabilityNote, undefined)
  })
  check('the row states the ladder low to max and the default medium', () => {
    const pin = gptDisplayPin(id)
    assert.ok(pin, `src/models/facts/pins/gptPins.ts gptDisplayPin(${id}) returned undefined`)
    assert.deepEqual(pin.supportedReasoningEfforts, listed)
    assert.equal(pin.defaultReasoningEffort, 'medium')
  })
  check('the row leads the table, which makes it the session default, and its Astra sibling follows it', () => {
    assert.equal(GPT_DISPLAY_PINS[0]?.id, id)
    assert.equal(GPT_DISPLAY_PINS[1]?.id, sibling)
  })
  check('the grammar reads the id: major 6, minor 2, variant sol', () => {
    const identity = parseGptModelId(`${id}[served]`)
    assert.deepEqual([identity?.major, identity?.minor, identity?.variant, identity?.canonicalId], [6, 2, 'sol', id])
  })
  check('one name through the display owners', () => {
    assert.deepEqual([gptDisplayName(id), getPublicModelDisplayName(id), renderModelName(id)], [name, name, name])
  })
  check('cold context and output read the page, not family defaults', () => {
    assert.equal(getContextWindowForModel(id), 1_050_000)
    assert.deepEqual(getModelMaxOutputTokens(id), { default: 128_000, upperLimit: 128_000 })
  })
  check('four Standard rates and the long-context tier', () => {
    const p = resolveModelPricing(id)
    assert.equal(p.basis, 'recorded')
    assert.deepEqual([p.costs.inputTokens, p.costs.promptCacheReadTokens, p.costs.promptCacheWriteTokens, p.costs.outputTokens], [2, 0.1, 2.5, 10])
    assert.equal(getModelPricingString(id), '$2/$10 per Mtok')
    const edge = resolveModelPricing(id, { promptTokens: 272_000 }).costs
    assert.deepEqual([edge.inputTokens, edge.outputTokens], [2, 10])
    const long = resolveModelPricing(id, { promptTokens: 272_001 }).costs
    assert.deepEqual([long.inputTokens, long.promptCacheReadTokens, long.promptCacheWriteTokens, long.outputTokens], [4, 0.2, 5, 15])
  })
  check('a turn of 50,000 plain, 50,000 cached, 50,000 written and 50,000 out costs 0.1 + 0.005 + 0.125 + 0.5 = 0.73 USD', () => {
    const usd = calculateUSDCost(id, { input_tokens: 50_000, output_tokens: 50_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_000 } as never)
    assert.ok(Math.abs(usd - 0.73) < 1e-9, String(usd))
  })
  check('native tool-search form', () => assert.equal(deferralWireFormFor(id, { env: {}, probeVerdict: () => undefined }).form, 'openai-native'))
  check('the request carries nothing the 6.2 guide says to omit, and keeps the stateless replay', () => {
    const request = requestFor('medium') as unknown as Record<string, unknown>
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs', 'prompt_cache_retention', 'prompt_cache_options', 'previous_response_id']) assert.equal(key in request, false, key)
    assert.deepEqual(request.include, ['reasoning.encrypted_content'])
    assert.equal(request.store, false)
    assert.deepEqual(openaiCacheRetention(id, 'api-key'), {})
    assert.deepEqual(openaiCacheRetention(id, 'chatgpt-subscription'), {})
  })
  process.env.OPENAI_API_KEY = 'fixture-key-not-real'
  await seed({ data: [{ id: sibling, priority: 1 }, { id, priority: 2 }, { id: 'gpt-6.1-sol', priority: 3 }] })
  check('a bare API list takes the input kinds and the ladder from the row', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed`)
    assert.equal(row.candidate.pin?.id, id)
    assert.deepEqual(row.candidate.live.inputModalities, ['text', 'image'])
    assert.ok(modelReceivesImageBlocks(id), `src/models/facts/capabilities.ts modelReceivesImageBlocks(${id}) returned false`)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, listed)
    assert.equal(row.candidate.live.defaultReasoningEffort, 'medium')
  })
  for (const word of asked) check(`on a bare API list ${word} asked sends ${listed.includes(word) ? word : 'low'}, so the refused word none cannot ride`, () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for ${word}`)
    const profile = catalogue.resolveGptReasoningProfile(word, row.candidate.live)
    const sent = listed.includes(word) ? word : 'low'
    assert.equal(profile.wireEffort, sent)
    assert.deepEqual(openaiEffortWireFact(requestFor(profile.wireEffort), true), { kind: 'sent', parameter: 'reasoning.effort', value: sent })
  })
  check('a bare API list with nothing asked sends the default medium', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for default effort`)
    assert.equal(catalogue.resolveGptReasoningProfile(undefined, row.candidate.live).wireEffort, 'medium')
  })
  check('the picker row: the page name, the OpenAI group, selectable, in the live order', () => {
    const rows = getModelOptions()
    const row = rows.find(r => r.value === id)
    assert.ok(row, `src/models/facts/modelOptions.ts getModelOptions missing ${id}`)
    assert.equal(row.label, name)
    assert.equal(row.group, OPENAI_MODEL_GROUP)
    assert.equal(row.unavailable, undefined)
    assert.ok(rows.findIndex(r => r.value === sibling) < rows.findIndex(r => r.value === id), `src/models/facts/modelOptions.ts expected ${sibling} before ${id}`)
    assert.ok(rows.findIndex(r => r.value === id) < rows.findIndex(r => r.value === 'gpt-6.1-sol'), `src/models/facts/modelOptions.ts expected ${id} before gpt-6.1-sol`)
  })
  await seed({ models: [{ slug: id, display_name: name, visibility: 'list', priority: 1, supported_reasoning_levels: listed.map(effort => ({ effort, description: effort })), default_reasoning_level: 'medium', context_window: 500_000, max_context_window: 872_000, input_modalities: ['text', 'image'], supported_in_api: true }] })
  for (const word of listed) check(`a list that states its levels sends ${word} as asked`, () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for stated ${word}`)
    const profile = catalogue.resolveGptReasoningProfile(word, row.candidate.live)
    assert.deepEqual([profile.wireEffort, profile.source], [word, 'user'])
    const request = requestFor(profile.wireEffort)
    assert.deepEqual(openaiEffortWireFact(request, true), { kind: 'sent', parameter: 'reasoning.effort', value: word })
  })
  for (const word of ['none', 'minimal']) check(`a list that states its levels answers ${word} with low, the word the 6.2 guide names`, () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for fallback ${word}`)
    const profile = catalogue.resolveGptReasoningProfile(word, row.candidate.live)
    assert.deepEqual([profile.wireEffort, profile.source, profile.adjustedFrom], ['low', 'unsupported-fallback', word])
  })
  check('a list that states its levels names the default it states and the windows it serves', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for stated windows`)
    assert.equal(catalogue.resolveGptReasoningProfile(undefined, row.candidate.live).wireEffort, 'medium')
    assert.equal(getContextWindowForModel(id), 872_000)
    assert.equal(getContextWindowForModel(`${id}[served]`), 500_000)
  })
  await seed({ data: [{ id, supported_reasoning_levels: [], input_modalities: ['text'] }] })
  check('explicit source facts outrank the page', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.ok(row.ok, `src/models/roads/openai/openaiCatalogue.ts evaluateGptCandidate(${id}, api-key) failed for explicit source facts`)
    assert.deepEqual(row.candidate.live.supportedReasoningEfforts, [])
    assert.deepEqual(row.candidate.live.inputModalities, ['text'])
  })
  await seed({ data: [{ id: 'gpt-6.1-sol' }] })
  check('the pin never admits an unlisted model, and the picker says it is not served', () => {
    const row = catalogue.evaluateGptCandidate(id, 'api-key')
    assert.equal(row.ok, false)
    const option = getModelOptions().find(r => r.value === id)
    assert.ok(option, `src/models/facts/modelOptions.ts unlisted ${id} missing from picker options`)
    assert.equal(option.label, name)
    assert.ok(typeof option.unavailable === 'string' && option.unavailable.includes('not served by the connected'), `src/models/facts/modelOptions.ts unlisted ${id} unavailable message mismatch: ${String(option.unavailable)}`)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} passed; facts read 2026-11-17: ${source}; https://developers.openai.com/api/docs/pricing; https://developers.openai.com/api/docs/guides/latest-model`)
process.exit(failures.length ? 1 : 0)
