#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { proofHome } from '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_XAI_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const cat = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const { writeStoredXaiApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { catalogueTrafficVerdict } = await import('../../src/services/providers/catalogueGate.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const { declaredRouteOf, providerDisplayName, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
const { modelFamilyWords, routeOfFamilyWord } = await import('../../src/utils/model/modelFamilies.ts')
const { xaiCatalogueEntries } = await import('../../src/utils/router/providers/xai.ts')
const { keyLanePins, getModelOptions, XAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { resolveContextWindow, effortVocabularyFor, modelSupportsThinking, modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')
let count = 0
const check = (name: string, ok: unknown): void => { assert.ok(ok, name); count++; console.log(`[PASS] ${name}`) }
let calls = 0
const page = (data: unknown[], status = 200): typeof fetch => (async (url, init) => {
  calls++
  assert.equal(String(url), 'http://127.0.0.1:1/v1/models')
  assert.equal(init?.method, 'GET')
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xai-fixture-stored')
  return Response.json({ data }, { status })
}) as typeof fetch
try {
  check('native Grok and alias route to xAI; carrier namespaces keep their owner', declaredRouteOf('grok') === 'xai' && declaredRouteOf('GROK-4.7') === 'xai' && declaredRouteOf('openrouter/x-ai/grok-4.7') === 'openrouter' && declaredRouteOf('compat/grok-4.7') === 'openai-compat')
  check('the family word table derives both xai and grok', modelFamilyWords().includes('xai') && routeOfFamilyWord('grok') === 'xai' && providerDisplayName('xai') === 'xAI')
  check('a native wire id is preserved', canonicalWireModelId('grok-4.7').ok)
  check('no key and no list means no model row, no speculative default', !catalogueTrafficVerdict('xai').allowed && cat.xaiCatalogueRows().rows.length === 0 && xaiCatalogueEntries().length === 0 && parseUserSpecifiedModel('grok') === 'grok')
  await cat.refreshXaiCatalogue({ fetchImpl: page([]) })
  check('signed-out catalogue makes no request', calls === 0)
  writeStoredXaiApiKey('xai-fixture-stored')
  const epoch = catalogueEpoch()
  const fixtures = [
    { id: 'grok-4.3', created: 1 },
    { id: 'grok-fixture-new', created: 3, context_length: 345_678, capabilities: { reasoning_effort: ['low', 'high'], default_reasoning_effort: 'low' } },
    { id: 'grok-4.7', created: 2, context_length: 456_789 },
    { id: 'grok-fixture-new', created: 3 },
    { id: 'grok-imagine-image', created: 9 }, { id: 'grok-4.20-multi-agent-0309', created: 10 },
    { id: 'grok-fixture-video', output_modalities: ['video'] }, { id: 'gpt-fixture', created: 99 },
  ]
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page(fixtures) })
  check('live list alone owns rows, newest creation time first, duplicates and other endpoints excluded', cat.xaiCatalogueRows().rows.map(row => row.id).join(',') === 'grok-fixture-new,grok-4.7,grok-4.3')
  check('settlement signals the catalogue epoch', catalogueEpoch() === epoch + 1)
  check('family alias and frontier pick the newest live row, not a hard-coded model', parseUserSpecifiedModel('grok') === 'grok-fixture-new' && providerFrontierFact('xai')?.modelId === 'grok-fixture-new')
  check('router and key-lane rows read the same account list', xaiCatalogueEntries().length === 3 && keyLanePins('xai')[0]?.id === 'grok-fixture-new')
  const options = getModelOptions().filter(row => row.group === XAI_MODEL_GROUP)
  check('picker offers only account-listed models', options.length === 3 && options.every(row => fixtures.some(model => model.id === row.value)))
  check('live context overrides dated pins, labelled as live', resolveContextWindow('grok-4.7').effectiveWindow === 456_789 && resolveContextWindow('grok-4.7').source === 'live-current')
  check('a manually saved 1M suffix cannot invent a larger Grok window', resolveContextWindow('grok-4.7[1m]').effectiveWindow === 456_789 && resolveContextWindow('grok-4.7[1m]').activation.kind === 'unavailable')
  check('unrecorded model keeps the raw name and its own live context and effort', cat.xaiCatalogueRows().rows[0]?.displayName === 'grok-fixture-new' && resolveContextWindow('grok-fixture-new').effectiveWindow === 345_678 && effortVocabularyFor('grok-fixture-new').kind === 'provider')
  check('unknown prices stay unpriced, dated xAI prices never borrow another family', resolveModelPricing('grok-fixture-new').basis === 'unpriced' && resolveModelPricing('grok-4.7').costs.inputTokens === 2)
  check('long context rate starts at exactly 200k prompt tokens', resolveModelPricing('grok-4.7', { promptTokens: 199_999 }).costs.outputTokens === 6 && resolveModelPricing('grok-4.7', { promptTokens: 200_000 }).costs.outputTokens === 12)
  check('documented non-reasoning model stays non-reasoning; known vision is explicit', !modelSupportsThinking('grok-4.20-0309-non-reasoning') && modelReceivesImageBlocks('grok-4.7') && !modelReceivesImageBlocks('grok-fixture-new'))
  await cat.refreshXaiCatalogue({ fetchImpl: page(fixtures) })
  check('the cached TTL sends nothing', calls === 1)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page(fixtures) })
  check('traffic-off veto applies even to forced refresh', calls === 1 && !cat.kickXaiCatalogue())
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.XAI_API_KEY = 'xai-fixture-other'
  check('a credential switch cannot inherit another account list', cat.getCachedXaiCatalogue() === null && cat.xaiCatalogueRows().rows.length === 0)
  delete process.env.XAI_API_KEY
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page([], 503) })
  check('a transient failure keeps only previously observed rows and its error', cat.xaiCatalogueRows().rows.length === 3 && cat.getCachedXaiCatalogue()?.lastError?.includes('503'))
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page([], 401) })
  check('an authentication refusal drops formerly usable rows', cat.xaiCatalogueRows().rows.length === 0 && cat.getCachedXaiCatalogue()?.lastError?.includes('refused'))
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page([]) })
  check('a successful empty list stays empty rather than falling back to pins', cat.xaiCatalogueRows().source.kind === 'live' && xaiCatalogueEntries().length === 0 && parseUserSpecifiedModel('grok') === 'grok')
  check('the empty live group remains visible as an honest action row', getModelOptions().some(row => row.group === XAI_MODEL_GROUP && row.label === 'xAI — no chat models listed'))
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page([{ id: 'grok-fixture-a' }, { id: 'grok-fixture-b' }]) })
  check('without timestamps the provider order is the tie-breaker', parseUserSpecifiedModel('grok') === 'grok-fixture-a')
  await cat.refreshXaiCatalogue({ force: true, fetchImpl: page([{ id: 'grok-4.7', capabilities: { reasoning_effort: [] } }]) })
  check('a live empty effort vocabulary overrides a documented pin', effortVocabularyFor('grok-4.7').kind === 'none')
  console.log(`XAI CATALOGUE GREEN (${count} checks; fixture only)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
