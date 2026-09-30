import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_META_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const cat = await import('../../src/services/providers/meta/metaCatalogue.ts')
const { writeStoredMetaApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { catalogueTrafficVerdict } = await import('../../src/services/providers/catalogueGate.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { parseUserSpecifiedModel, getCanonicalName } = await import('../../src/utils/model/model.ts')
const { declaredRouteOf, providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { modelFamilyWords, routeOfFamilyWord } = await import('../../src/utils/model/modelFamilies.ts')
const { metaCatalogueEntries } = await import('../../src/utils/router/providers/meta.ts')
const { keyLanePins, getModelOptions, META_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { resolveContextWindow, effortVocabularyFor, modelThinkingAlwaysOn, modelReceivesImageBlocks, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
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
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer meta-fixture-stored')
  return Response.json({ data }, { status })
}) as typeof fetch
try {
  check('Muse and its family alias route to Meta while carrier namespaces keep their owner', declaredRouteOf('muse') === 'meta' && declaredRouteOf('MUSE-SPARK-1.3') === 'meta' && declaredRouteOf('openrouter/meta/muse-spark-1.3') === 'openrouter' && declaredRouteOf('compat/muse-spark-1.3') === 'openai-compat')
  check('family words derive meta and muse without a hidden vendor preference', modelFamilyWords().includes('meta') && routeOfFamilyWord('muse') === 'meta' && providerDisplayName('meta') === 'Meta')
  check('point releases keep their own canonical identity', getCanonicalName('muse-spark-1.3') === 'muse-spark-1.3' && getCanonicalName('muse-spark-1.2') === 'muse-spark-1.2')
  check('no key and no list means no selectable row or speculative default', !catalogueTrafficVerdict('meta').allowed && cat.metaCatalogueRows().rows.length === 0 && metaCatalogueEntries().length === 0 && parseUserSpecifiedModel('muse') === 'muse')
  await cat.refreshMetaCatalogue({ fetchImpl: page([]) })
  check('a signed-out catalogue makes no request', calls === 0)
  writeStoredMetaApiKey('meta-fixture-stored')
  const epoch = catalogueEpoch()
  const models = [
    { id: 'muse-spark-1.1', created: 1 }, { id: 'muse-spark-1.3', created: 3 },
    { id: 'muse-spark-fixture-new', created: 4 }, { id: 'muse-spark-1.3-contributor', created: 9 },
    { id: 'muse-spark-fixture-new', created: 4 }, { id: 'muse-image-1.0', created: 99 },
    { id: 'muse-voice-transcribe-1.0', created: 99 }, { id: 'sam-3.1', created: 99 },
    { id: 'muse-spark-fixture-invalid' }, { id: 'gpt-fixture', created: 100 },
  ]
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page(models) })
  check('live list owns rows, duplicates and non-chat endpoints excluded', cat.metaCatalogueRows().rows.map(row => row.id).join(',') === 'muse-spark-fixture-new,muse-spark-1.3,muse-spark-1.1,muse-spark-1.3-contributor')
  check('settlement bumps the catalogue epoch', catalogueEpoch() === epoch + 1)
  check('alias and frontier select the newest served Standard row, not a pin or training tier', parseUserSpecifiedModel('muse') === 'muse-spark-fixture-new' && providerFrontierFact('meta')?.modelId === 'muse-spark-fixture-new')
  check('router and picker read the same account list', metaCatalogueEntries().length === 4 && keyLanePins('meta')[0]?.id === 'muse-spark-fixture-new')
  const options = getModelOptions().filter(row => row.group === META_MODEL_GROUP)
  check('picker offers exactly account-listed chat models', options.length === 4 && options.every(row => models.some(model => model.id === row.value)))
  check('Contributor disclosure is visible on its row', options.some(row => row.value === 'muse-spark-1.3-contributor' && row.label.includes('training permitted')))
  check('documented context and output facts are not confused with list metadata', resolveContextWindow('muse-spark-1.3').effectiveWindow === 1_048_576 && getModelMaxOutputTokens('muse-spark-1.3').upperLimit === 131_072)
  check('a saved 1M suffix never invents an activation mechanism', resolveContextWindow('muse-spark-1.3[1m]').effectiveWindow === 1_048_576 && resolveContextWindow('muse-spark-1.3[1m]').activation.kind === 'unavailable')
  check('unrecorded served ids have no invented price, context, image support or effort', resolveModelPricing('muse-spark-fixture-new').basis === 'unpriced' && cat.metaCatalogueRows().rows[0]?.contextWindow === undefined && !modelReceivesImageBlocks('muse-spark-fixture-new') && effortVocabularyFor('muse-spark-fixture-new').kind === 'none')
  check('dated prices belong to the exact Meta tiers and have no context premium', resolveModelPricing('muse-spark-1.3').costs.inputTokens === 1.25 && resolveModelPricing('muse-spark-1.3', { promptTokens: 500_000 }).costs.outputTokens === 4.25 && resolveModelPricing('muse-spark-1.3-contributor').costs.inputTokens === 0.1)
  check('Spark always reasons and Standard 1.3 alone advertises max', modelThinkingAlwaysOn('muse-spark-1.3') && JSON.stringify(effortVocabularyFor('muse-spark-1.3')).includes('max') && !JSON.stringify(effortVocabularyFor('muse-spark-1.3-contributor')).includes('max'))
  check('named off-list and non-chat ids are refused without inference', !(await validateModel('muse-spark-fixture-absent')).valid && !(await validateModel('muse-image-1.0')).valid)
  await cat.refreshMetaCatalogue({ fetchImpl: page(models) })
  check('cached TTL makes no second request', calls === 1)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page(models) })
  check('the traffic-off gate vetoes a forced refresh', calls === 1 && !cat.kickMetaCatalogue())
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.MODEL_API_KEY = 'meta-fixture-other'
  check('another credential cannot inherit the account list', cat.getCachedMetaCatalogue() === null && cat.metaCatalogueRows().rows.length === 0)
  delete process.env.MODEL_API_KEY
  const base = process.env.MERCURY_META_API_BASE
  process.env.MERCURY_META_API_BASE = 'http://127.0.0.1:2/v1'
  check('another base cannot inherit the account list', cat.getCachedMetaCatalogue() === null)
  process.env.MERCURY_META_API_BASE = base
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page([], 503) })
  check('a transient failure retains only previously observed rows with its error', cat.metaCatalogueRows().rows.length === 4 && cat.getCachedMetaCatalogue()?.lastError?.includes('503'))
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page([], 401) })
  check('an auth refusal drops formerly usable rows', cat.metaCatalogueRows().rows.length === 0 && cat.getCachedMetaCatalogue()?.lastError?.includes('refused'))
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page([]) })
  check('a successful empty list stays empty with an honest picker action', cat.metaCatalogueRows().source.kind === 'live' && metaCatalogueEntries().length === 0 && getModelOptions().some(row => row.group === META_MODEL_GROUP && row.label === 'Meta — no Muse Spark models listed'))
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page([{ id: 'muse-spark-1.3-contributor', created: 9 }]) })
  check('Contributor-only accounts cannot opt into training via an automatic family alias', cat.newestMetaModel() === undefined && !(await validateModel('muse')).valid && (await validateModel('muse-spark-1.3-contributor')).valid)
  await cat.refreshMetaCatalogue({ force: true, fetchImpl: page([{ id: 'muse-spark-fixture-b', created: 5 }, { id: 'muse-spark-fixture-a', created: 5 }]) })
  check('creation-time ties use the documented stable id order', cat.newestMetaModel() === 'muse-spark-fixture-a')
  console.log(`META CATALOGUE GREEN (${count} checks; fixture only)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
