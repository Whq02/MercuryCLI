import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { MISTRAL_FIXTURE_MODELS } from '../providers/lib/mistral-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_MISTRAL_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const cat = await import('../../src/services/providers/mistral/mistralCatalogue.ts')
const { writeStoredMistralApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { catalogueTrafficVerdict } = await import('../../src/services/providers/catalogueGate.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { parseUserSpecifiedModel, getCanonicalName } = await import('../../src/utils/model/model.ts')
const { declaredRouteOf, providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { modelFamilyWords, routeOfFamilyWord } = await import('../../src/utils/model/modelFamilies.ts')
const { mistralCatalogueEntries } = await import('../../src/utils/router/providers/mistral.ts')
const { keyLanePins, getModelOptions, MISTRAL_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { resolveContextWindow, effortVocabularyFor, modelSupportsThinking, modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')
const { validateModel } = await import('../../src/utils/model/validateModel.ts')
let count = 0
const check = (name: string, ok: unknown): void => { assert.ok(ok, name); count++; console.log(`[PASS] ${name}`) }
let calls = 0
const page = (data: unknown[], status = 200): typeof fetch => (async (url, init) => {
  calls++
  assert.equal(String(url), 'http://127.0.0.1:1/v1/models')
  assert.equal(init?.method, 'GET')
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer proof-key-mistral-fixture-stored')
  return Response.json(status === 200 ? { object: 'list', data } : { object: 'error', message: 'fixture', type: 'authentication_error' }, { status })
}) as typeof fetch
try {
  check('the family word and the three bare prefixes route to Mistral while carrier namespaces keep their owner', declaredRouteOf('mistral') === 'mistral' && declaredRouteOf('MISTRAL-LARGE-4') === 'mistral' && declaredRouteOf('ministral-8b-2512') === 'mistral' && declaredRouteOf('codestral-2508') === 'mistral' && declaredRouteOf('openrouter/mistralai/mistral-large') === 'openrouter' && declaredRouteOf('compat/mistral-large-4') === 'openai-compat' && declaredRouteOf('huggingface/mistralai/Mistral-7B') === 'huggingface')
  check('the family word derives mistral without a hidden vendor preference', modelFamilyWords().includes('mistral') && routeOfFamilyWord('mistral') === 'mistral' && providerDisplayName('mistral') === 'Mistral')
  check('dated ids keep their own canonical identity', getCanonicalName('mistral-large-4') === 'mistral-large-4' && getCanonicalName('mistral-small-2603') === 'mistral-small-2603')
  check('no key and no list means no selectable row or speculative default', !catalogueTrafficVerdict('mistral').allowed && cat.mistralCatalogueRows().rows.length === 0 && mistralCatalogueEntries().length === 0 && parseUserSpecifiedModel('mistral') === 'mistral')
  await cat.refreshMistralCatalogue({ fetchImpl: page([]) })
  check('a signed-out catalogue makes no request', calls === 0)
  writeStoredMistralApiKey('proof-key-mistral-fixture-stored')
  const epoch = catalogueEpoch()
  const models = [...MISTRAL_FIXTURE_MODELS, { id: 'mistral-fixture-new', created: 2_000_000_000, aliases: ['mistral-fixture-latest'], capabilities: { completion_chat: true, reasoning: true, vision: false } }, { id: 'mistral-large-4', created: 1 }, { id: 'gpt-fixture', created: 100 }, { id: 'mistral-moderation-2603', created: 5, capabilities: { completion_chat: false } }]
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page(models) })
  const rows = cat.mistralCatalogueRows().rows.map(row => row.id)
  check('the live list owns the rows: pinned order first, duplicates, non-chat and deprecated rows out, unpinned rows by recency', rows.join(',') === 'mistral-large-4,mistral-medium-3-5,mistral-small-2603,mistral-large-2512,codestral-2508,mistral-fixture-new')
  check('the third-party row the account serves is not a Mistral-family model', !rows.includes('zai-glm-5-3') && !rows.includes('gpt-fixture'))
  check('settlement bumps the catalogue epoch', catalogueEpoch() === epoch + 1)
  check('the family word and the frontier select the first served pin, Large 4', parseUserSpecifiedModel('mistral') === 'mistral-large-4' && providerFrontierFact('mistral')?.modelId === 'mistral-large-4')
  check('router and picker read the same account list', mistralCatalogueEntries().length === 6 && keyLanePins('mistral')[0]?.id === 'mistral-large-4')
  const options = getModelOptions().filter(row => row.group === MISTRAL_MODEL_GROUP)
  check('the picker offers exactly the account-listed chat models', options.length === 6 && options.every(row => models.some(model => (model as { id: string }).id === row.value)))
  check('the live list states the context and the capabilities the pins carry', resolveContextWindow('mistral-large-4').effectiveWindow === 1_048_576 && resolveContextWindow('codestral-2508').effectiveWindow === 131_072 && modelSupportsThinking('mistral-large-4') && !modelSupportsThinking('mistral-large-2512') && modelReceivesImageBlocks('mistral-small-2603') && !modelReceivesImageBlocks('codestral-2508'))
  check('vendor aliases are listed ids too: the alias validates and dispatches as its row', cat.mistralListedModel(cat.getCachedMistralCatalogue(), 'mistral-medium-latest')?.id === 'mistral-medium-3-5' && (await validateModel('mistral-large-latest')).valid)
  check('a saved 1M suffix never invents an activation mechanism', resolveContextWindow('mistral-large-4[1m]').effectiveWindow === 1_048_576 && resolveContextWindow('mistral-large-4[1m]').activation.kind === 'unavailable')
  check('an unrecorded served row takes its facts from the live list and invents no price', resolveModelPricing('mistral-fixture-new').basis === 'unpriced' && effortVocabularyFor('mistral-fixture-new').kind === 'provider' && !modelReceivesImageBlocks('mistral-fixture-new') && cat.mistralCatalogueRows().rows.at(-1)?.contextWindow === undefined)
  check('dated prices belong to the exact Mistral rows', resolveModelPricing('mistral-large-4').costs.inputTokens === 1.36 && resolveModelPricing('mistral-large-4').costs.outputTokens === 4.18 && resolveModelPricing('mistral-small-2603').costs.inputTokens === 0.15 && resolveModelPricing('ministral-3b-2512').basis === 'recorded')
  const homeBase = process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  const refusedOffList = !(await validateModel('mistral-fixture-absent')).valid && !(await validateModel('devstral-2512')).valid && !(await validateModel('mistral-embed')).valid
  if (homeBase !== undefined) process.env.ANTHROPIC_BASE_URL = homeBase
  check('named off-list, retired and non-chat ids are refused without inference (on the first-party home base: a re-pointed ANTHROPIC_BASE_URL is the one operator-owned fact that admits an undeclared id, by the id-space law)', refusedOffList)
  await cat.refreshMistralCatalogue({ fetchImpl: page(models) })
  check('the cached TTL makes no second request', calls === 1)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page(models) })
  check('the traffic-off gate vetoes a forced refresh', calls === 1 && !cat.kickMistralCatalogue())
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.MISTRAL_API_KEY = 'proof-key-mistral-fixture-other'
  check('another credential cannot inherit the account list', cat.getCachedMistralCatalogue() === null && cat.mistralCatalogueRows().rows.length === 0)
  delete process.env.MISTRAL_API_KEY
  const base = process.env.MERCURY_MISTRAL_API_BASE
  process.env.MERCURY_MISTRAL_API_BASE = 'http://127.0.0.1:2/v1'
  check('another base cannot inherit the account list', cat.getCachedMistralCatalogue() === null)
  process.env.MERCURY_MISTRAL_API_BASE = base
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page([], 503) })
  check('a transient failure retains only previously observed rows with its error', cat.mistralCatalogueRows().rows.length === 6 && cat.getCachedMistralCatalogue()?.lastError?.includes('503'))
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page([], 401) })
  check('an auth refusal drops formerly usable rows', cat.mistralCatalogueRows().rows.length === 0 && cat.getCachedMistralCatalogue()?.lastError?.includes('refused'))
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page([]) })
  check('a successful empty list stays empty with an honest picker action', cat.mistralCatalogueRows().source.kind === 'live' && mistralCatalogueEntries().length === 0 && getModelOptions().some(row => row.group === MISTRAL_MODEL_GROUP && row.label === 'Mistral — no chat models listed') && !(await validateModel('mistral')).valid)
  await cat.refreshMistralCatalogue({ force: true, fetchImpl: page([{ id: 'mistral-fixture-b', created: 5, capabilities: { completion_chat: true } }, { id: 'mistral-fixture-a', created: 5, capabilities: { completion_chat: true } }]) })
  check('unpinned rows with equal creation times use the stable id order', cat.newestMistralModel() === 'mistral-fixture-a')
  console.log(`MISTRAL CATALOGUE GREEN (${count} checks; fixture only)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
