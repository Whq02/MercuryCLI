#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { proofHome } from '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['ZAI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'MOONSHOT_API_KEY', 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:1/v4'
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const cat = await import('../../src/models/roads/zai/zaiCatalogue.ts')
const pins = await import('../../src/models/facts/pins/glmPins.ts')
const { writeStoredZaiApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { catalogueTrafficVerdict, connectToBrowseReason } = await import('../../src/models/roads/catalogueGate.ts')
const { KEYED_CATALOGUE_FAMILIES, readCatalogueIfPending } = await import('../../src/models/roads/catalogueOnDemand.ts')
const { catalogueEpoch } = await import('../../src/models/roads/catalogueEpoch.ts')
const { parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.ts')
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const router = await import('../../src/models/roads/zai/zaiAdapter.ts')
const { keyLanePins, keyLaneListState, getModelOptions, ZAI_MODEL_GROUP, LIVE_UNKNOWN_ROW_WORDS } = await import('../../src/models/catalogue/modelOptions.ts')
const { resolveContextWindow, effortVocabularyFor } = await import('../../src/models/facts/capabilities.ts')
const { resolveModelPricing } = await import('../../src/models/usage/modelCost.ts')
const { providerFrontierFact } = await import('../../src/models/catalogue/providerFrontier.ts')
const { readModelListFacts } = await import('../../src/models/roads/typedModelIds.ts')
const { zaiApiBase } = await import('../../src/models/roads/zai/zaiClient.ts')

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'zai-models-2026-10-05.json'), 'utf8')) as { data: Array<{ id: string }> }
for (const row of FIXTURE.data) if (row.id === 'glm-5-turbo') row.id = 'glm-5-unlisted'
const LIVE_IDS_NEWEST_FIRST = 'glm-5.3,glm-5.3-flash,glm-5.3-flashx,glm-5.2,glm-5.1,glm-5-unlisted,glm-5,glm-4.7,glm-4.6,glm-4.5,glm-4.5-air'
const FLOOR = 'glm-5.3,glm-5.3-flash,glm-5.2'

let count = 0
const ZAI_FAILURE_HINT = 'what to change: the Z.AI catalogue rows, source and refresh in src/models/roads/zai/zaiCatalogue.ts, the adapter view in src/models/roads/zai/zaiAdapter.ts, the model pins in src/models/facts/pins/glmPins.ts, or the picker rows in src/models/catalogue/modelOptions.ts, whichever this check names; the list fixture is scripts/providers/fixtures/zai-models-2026-10-05.json'
const check = (name: string, ok: unknown, detail = ''): void => {
  assert.ok(ok, `${name}${detail ? ` — ${detail}` : ''} — ${ZAI_FAILURE_HINT}`)
  count++
  console.log(`[PASS] ${name}`)
}
const ids = (rows: ReadonlyArray<{ id: string }>): string => rows.map(row => row.id).join(',')
const requests: string[] = []
const page = (body: unknown, status = 200): typeof fetch =>
  (async (url, init) => {
    requests.push(String(url))
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer zai-fixture-stored-coding-key')
    return Response.json(body, { status })
  }) as typeof fetch
const glmRows = (): ReturnType<typeof getModelOptions> => getModelOptions().filter(row => row.group === ZAI_MODEL_GROUP)

try {
  check('the family is a keyed catalogue family and the door names it', KEYED_CATALOGUE_FAMILIES.includes('zai') && connectToBrowseReason('zai') === 'connect Z.AI to browse its models')
  check('signed out: the door refuses, the rows are the dated floor, the provenance is the pin', !catalogueTrafficVerdict('zai').allowed && ids(cat.zaiCatalogueRows().rows) === FLOOR && cat.zaiCatalogueRows().source.kind === 'pin' && router.describeZaiProvider().catalogueSource === 'static-pin', ids(cat.zaiCatalogueRows().rows))
  check('the floor carries the flash row with its documented window', cat.zaiCatalogueRows().rows.find(row => row.id === 'glm-5.3-flash')?.contextWindow === 1_000_000)
  await cat.refreshZaiCatalogue({ fetchImpl: page(FIXTURE) })
  check('a signed-out refresh makes no request', requests.length === 0)
  check('the list base follows the plan: the Coding Plan base for a coding key, the general base otherwise', zaiApiBase({}, 'coding') === 'https://api.z.ai/api/coding/paas/v4' && zaiApiBase({}, 'general') === 'https://api.z.ai/api/paas/v4')

  writeStoredZaiApiKey('zai-fixture-stored-coding-key', 'coding')
  check('a stored Coding Plan key opens the door', catalogueTrafficVerdict('zai').allowed)
  const epoch = catalogueEpoch()
  const snapshot = await cat.refreshZaiCatalogue({ force: true, fetchImpl: page(FIXTURE) })
  check('the list is read once from <base>/models with the bearer key (the base pinned to a dead loopback for the gate)', requests.length === 1 && requests[0] === 'http://127.0.0.1:1/v4/models', requests.join(','))
  check('the snapshot lands 11 rows under the coding plan with no error', snapshot?.models.length === 11 && snapshot.plan === 'coding' && snapshot.keySource === 'stored' && snapshot.lastError === undefined, JSON.stringify(snapshot))
  check('settlement signals the catalogue epoch', catalogueEpoch() === epoch + 1)
  check('the rows are the list, newest creation first, the flagship family leading', ids(cat.zaiCatalogueRows().rows) === LIVE_IDS_NEWEST_FIRST, ids(cat.zaiCatalogueRows().rows))
  check('the source is live and counts every row', cat.zaiCatalogueRows().source.kind === 'live' && (cat.zaiCatalogueRows().source as { count: number }).count === 11 && cat.zaiCatalogueSourceWords() === '11 models live')
  const flash = cat.zaiCatalogueRows().rows.find(row => row.id === 'glm-5.3-flash')
  check('glm-5.3-flash reads its pin: GLM-5.3-Flash, 1M window, listed live, dated by docs.z.ai chat-completion, read 2026-10-25', flash?.displayName === 'GLM-5.3-Flash' && flash.contextWindow === 1_000_000 && flash.listedLive === true && flash.liveUnknown === undefined && flash.observedAt === '2026-10-25', JSON.stringify(flash))
  const unlisted = cat.zaiCatalogueRows().rows.find(row => row.id === 'glm-5-unlisted')
  check('an id the docs never name is live and unknown: raw spelling, no window, dated by the fetch', unlisted?.displayName === 'GLM-5-Unlisted' && unlisted.contextWindow === undefined && unlisted.liveUnknown === true && /^\d{4}-\d{2}-\d{2}$/.test(unlisted.observedAt), JSON.stringify(unlisted))
  check('cachedLiveIds names every listed id', [...cat.cachedLiveIds()].sort().join(',') === FIXTURE.data.map(row => row.id).sort().join(','))

  const described = router.describeZaiProvider()
  check('the account view reads live-discovery with the fetch stamp', described.catalogueSource === 'live-discovery' && described.discoveredAtMs === snapshot?.fetchedAtMs && described.catalogue.length === 11)
  const entryEfforts = (id: string): string => router.zaiCatalogueEntry(id)?.efforts.join(',') ?? '<absent>'
  check('the catalogue carries each model its own dial: the 5.3 family low|high|max, glm-5.2 the seven levels, older ids none', entryEfforts('glm-5.3-flash') === 'low,high,max' && entryEfforts('glm-5.3-flashx') === 'low,high,max' && entryEfforts('glm-5.3') === 'low,high,max' && entryEfforts('glm-5.2') === 'max,xhigh,high,medium,low,minimal,none' && entryEfforts('glm-5.1') === '' && entryEfforts('glm-5-unlisted') === '', [entryEfforts('glm-5.3-flash'), entryEfforts('glm-5.2'), entryEfforts('glm-5.1')].join(' | '))
  check('the exact-id road finds a listed id and its window; an unlisted id is absent', router.zaiCatalogueEntry('glm-5.1')?.contextWindow === 200_000 && router.zaiCatalogueEntry('GLM-5.3-Flash')?.displayLabel === 'GLM-5.3-Flash' && router.zaiCatalogueEntry('glm-9') === undefined)
  check('the seat listing offers every listed row', router.listZaiModels().map(row => row.ref.model).join(',') === LIVE_IDS_NEWEST_FIRST)

  check('the picker state reads live 11 and the pins are the rows', keyLaneListState('zai').kind === 'live' && keyLanePins('zai').length === 11 && keyLanePins('zai').every(pin => pin.listedLive === true))
  const options = glmRows()
  check('/model offers every listed model under the GLM group, selectable, the known rows in list order and the unknown one last', ids(options.map(row => ({ id: row.value }))) === 'glm-5.3,glm-5.3-flash,glm-5.3-flashx,glm-5.2,glm-5.1,glm-5,glm-4.7,glm-4.6,glm-4.5,glm-4.5-air,glm-5-unlisted' && options.every(row => row.unavailable === undefined), ids(options.map(row => ({ id: row.value }))))
  const flashRow = options.find(row => row.value === 'glm-5.3-flash')
  check('the flash row paints its name and 1M window', flashRow?.label === 'GLM-5.3-Flash' && flashRow.statedContextWindow === 1_000_000 && flashRow.description === '', JSON.stringify(flashRow))
  const unlistedRow = options.find(row => row.value === 'glm-5-unlisted')
  check('the unknown live row says so and paints no window', unlistedRow?.description === LIVE_UNKNOWN_ROW_WORDS && unlistedRow.liveUnknown === true && unlistedRow.statedContextWindow === undefined, JSON.stringify(unlistedRow))

  const vocabulary = effortVocabularyFor('glm-5.3-flash')
  check('the capability edge offers the flash dial from the same table', vocabulary.kind === 'provider' && vocabulary.source === 'glm' && vocabulary.vocabulary.join(',') === 'low,high,max' && vocabulary.thinkingGated === false, JSON.stringify(vocabulary))
  check('thinking is locked on for the whole 5.3 family and free below it', pins.glmThinkingLocked('glm-5.3-flash') && pins.glmThinkingLocked('glm-5.3-flashx') && pins.glmThinkingLocked('glm-5.3') && !pins.glmThinkingLocked('glm-5.2') && !pins.glmThinkingLocked('glm-5-turbo'))
  check('an undocumented live id offers no dial', effortVocabularyFor('glm-5-unlisted').kind === 'none')
  const window = resolveContextWindow('glm-5.3-flash')
  check('the flash window is the documented 1M, as a dated pin', window.effectiveWindow === 1_000_000 && window.source === 'static-pin', JSON.stringify(window))
  check('an older documented id keeps its own window', resolveContextWindow('glm-5.1').effectiveWindow === 200_000 && resolveContextWindow('glm-4.5-air').effectiveWindow === 128_000)
  check('the unknown live id budgets the conservative default, never an invented window', resolveContextWindow('glm-5-unlisted').effectiveWindow === 200_000 && resolveContextWindow('glm-5-unlisted').source !== 'static-pin', JSON.stringify(resolveContextWindow('glm-5-unlisted')))
  check("the flash price is the page's current rate; FlashX is priced; the unknown id stays unpriced", resolveModelPricing('glm-5.3-flash').costs.inputTokens === 0.15 && resolveModelPricing('glm-5.3-flash').costs.outputTokens === 0.5 && resolveModelPricing('glm-5.3-flashx').costs.inputTokens === 0.37 && resolveModelPricing('glm-5-unlisted').basis === 'unpriced', JSON.stringify(resolveModelPricing('glm-5.3-flash')))
  const turbo = pins.GLM_DISPLAY_PINS.find(pin => pin.id === 'glm-5-turbo')
  check('glm-5-turbo has its own row: GLM-5-Turbo, the 200K window and the 128K output its page states (docs.z.ai/guides/llm/glm-5-turbo, read 2026-11-20; the API reference writes 128K as 131072), no dial, and no price, since no Z.AI page prints one', turbo?.displayName === 'GLM-5-Turbo' && turbo.contextWindow === 200_000 && turbo.outputMax === 131_072 && turbo.observedAt === '2026-11-20' && resolveContextWindow('glm-5-turbo').effectiveWindow === 200_000 && resolveContextWindow('glm-5-turbo').source === 'static-pin' && effortVocabularyFor('glm-5-turbo').kind === 'none' && resolveModelPricing('glm-5-turbo').basis === 'unpriced' && pins.GLM_PRICE_PINS.every(pin => pin.id !== 'glm-5-turbo'), JSON.stringify([turbo, resolveContextWindow('glm-5-turbo')]))
  check('every price pin cites the page and its read date', pins.GLM_PRICE_PINS.every(pin => pin.source === pins.GLM_PRICING_PAGE && /^\d{4}-\d{2}-\d{2}$/.test(pin.observedAt)))

  check("the family word 'glm' is the newest live row, and the frontier fact names that row with no pin date while the list is live", parseUserSpecifiedModel('glm') === 'glm-5.3' && declaredRouteOf('glm-5.3-flash') === 'zai' && JSON.stringify(providerFrontierFact('zai')) === JSON.stringify({ modelId: 'glm-5.3', displayName: 'GLM-5.3' }) && cat.zaiCatalogueSourceWords() === '11 models live', JSON.stringify(providerFrontierFact('zai')))
  const fact = readModelListFacts().find(row => row.family === 'zai')
  check('the health row judges the typed floor against the live list: every floor id served', fact?.list.kind === 'list' && fact.list.ids.length === 11 && fact.typed.join(',') === FLOOR && fact.source === 'GLM Coding Plan key (stored)', JSON.stringify(fact))

  await cat.refreshZaiCatalogue({ fetchImpl: page(FIXTURE) })
  check('inside the TTL nothing is sent', requests.length === 1)
  check('an on-demand read with rows cached makes no request', (await readCatalogueIfPending('zai')) === false && requests.length === 1)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  await cat.refreshZaiCatalogue({ force: true, fetchImpl: page(FIXTURE) })
  check('traffic-off vetoes even a forced refresh and the kick', requests.length === 1 && !cat.kickZaiCatalogue())
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

  process.env.ZAI_API_KEY = 'zai-fixture-env-general-key'
  check('another credential never inherits this list: the env key sees the floor', cat.getCachedZaiCatalogue() === null && ids(cat.zaiCatalogueRows().rows) === FLOOR && router.describeZaiProvider().catalogueSource === 'static-pin')
  const envRequests: string[] = []
  await cat.refreshZaiCatalogue({ force: true, fetchImpl: (async (url: unknown, init?: RequestInit) => { envRequests.push(`${new Headers(init?.headers).get('authorization')} ${String(url)}`); return Response.json({ data: [] }) }) as typeof fetch })
  check('an env key reads its own list under its own bearer, as a general-plan snapshot', envRequests[0] === 'Bearer zai-fixture-env-general-key http://127.0.0.1:1/v4/models' && cat.getCachedZaiCatalogue()?.plan === 'general', envRequests.join(','))
  check('a successful empty list never drops below the floor: the floor rows stand with the pin provenance', cat.zaiCatalogueRows().source.kind === 'pin' && ids(cat.zaiCatalogueRows().rows) === FLOOR && router.describeZaiProvider().catalogueSource === 'static-pin' && cat.getCachedZaiCatalogue()?.lastError === undefined)
  delete process.env.ZAI_API_KEY
  check('back on the stored key the list is there again', ids(cat.zaiCatalogueRows().rows) === LIVE_IDS_NEWEST_FIRST)

  await cat.refreshZaiCatalogue({ force: true, fetchImpl: page({ error: { code: '1305', message: 'fixture busy' } }, 503) })
  check('a transient failure keeps the observed rows and labels the error', ids(cat.zaiCatalogueRows().rows) === LIVE_IDS_NEWEST_FIRST && cat.getCachedZaiCatalogue()?.lastError?.includes('503'), String(cat.getCachedZaiCatalogue()?.lastError))
  await cat.refreshZaiCatalogue({ force: true, fetchImpl: page({ error: { code: '1002', message: 'fixture refused' } }, 401) })
  check('a credential refusal drops the rows to the floor and says refused', ids(cat.zaiCatalogueRows().rows) === FLOOR && cat.zaiCatalogueRows().source.kind === 'pin' && cat.getCachedZaiCatalogue()?.lastError?.includes('refused the credential'), String(cat.getCachedZaiCatalogue()?.lastError))
  check('no receipt of the key rides the error', !JSON.stringify(cat.getCachedZaiCatalogue()).includes('zai-fixture-stored-coding-key'))
  cat.__resetZaiCatalogueForTest()
  const kicked = cat.kickZaiCatalogue({ fetchImpl: page(FIXTURE) })
  await new Promise(resolve => setTimeout(resolve, 20))
  check('the picker kick reads the list once in the background', kicked && ids(cat.zaiCatalogueRows().rows) === LIVE_IDS_NEWEST_FIRST && !cat.kickZaiCatalogue())
  console.log(`ZAI CATALOGUE GREEN (${count} checks; fixture only)`)
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}
