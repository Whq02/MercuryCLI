#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'moonshot-catalogue-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of ['MOONSHOT_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'CI', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[name]
process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/platform'
process.env.MERCURY_MOONSHOT_CODING_BASE = 'http://127.0.0.1:1/coding'
process.env.MERCURY_MOONSHOT_OAUTH_BASE = 'http://127.0.0.1:1/auth'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { writeStoredMoonshotApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { writeMoonshotTokens } = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')
const { describeMoonshotProvider, listMoonshotModels } = await import('../../src/utils/router/providers/moonshot.ts')
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts').catch(() => null)
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const page = { object: 'list', data: [
  { id: 'kimi-k2.6', object: 'model', created: 100, owned_by: 'moonshot', context_length: 262144, supports_image_in: true, supports_video_in: false, supports_reasoning: true },
  { id: 'kimi-fixture-next', object: 'model', created: 200, owned_by: 'moonshot', context_length: 524288, supports_image_in: true, supports_video_in: true, supports_reasoning: true },
] }
let calls: Array<{ url: string; method?: string; bearer: string | null; signal: boolean }> = []
const pageFetch = (body: unknown = page, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), method: init?.method, bearer: new Headers(init?.headers).get('authorization'), signal: init?.signal instanceof AbortSignal })
  return Response.json(body, { status })
}) as typeof fetch
check('the Moonshot live-catalogue owner exists', catalogue !== null)
if (catalogue) {
  const c = catalogue
  const decode = c.decodeMoonshotModel(page.data[0])
  check('the documented model fields decode without borrowing another row', decode?.id === 'kimi-k2.6' && decode.created === 100 && decode.contextWindow === 262144 && decode.supportsImage === true && decode.supportsVideo === false && decode.supportsReasoning === true)
  check('missing ids and invalid numeric metadata do not become facts', c.decodeMoonshotModel({}) === undefined && c.decodeMoonshotModel({ id: 'kimi-next', created: -1, context_length: '100' })?.contextWindow === undefined)
  const fetched = await c.fetchMoonshotLiveModels({ baseUrl: 'http://127.0.0.1:1/platform/', key: 'fixture-key', fetchImpl: pageFetch() })
  check('one bearer GET on the supplied base, with the provider deadline signal', calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:1/platform/models' && calls[0].method === 'GET' && calls[0].bearer === 'Bearer fixture-key' && calls[0].signal)
  check('the documented response lands with two rows', fetched.models.length === 2)
  for (const body of [{}, null, { data: 'wrong' }, { data: [{ id: 'gpt-foreign' }] }]) {
    const refused = await c.fetchMoonshotLiveModels({ baseUrl: 'http://127.0.0.1:1/platform', key: 'fixture-key', fetchImpl: pageFetch(body) }).then(() => false, () => true)
    check('a malformed or foreign catalogue is not an authoritative empty list', refused, JSON.stringify(body))
  }
  calls = []
  check('signed out: refresh is a non-event', await c.refreshMoonshotCatalogue({ fetchImpl: pageFetch() }) === null && calls.length === 0)
  check('signed out: kick starts nothing', !c.kickMoonshotCatalogue({ fetchImpl: pageFetch() }) && calls.length === 0)
  writeStoredMoonshotApiKey('fixture-stored-one')
  const pins = c.moonshotCatalogueRows()
  check('without a fetched list, only dated observations stand in', pins.source.kind === 'pin' && pins.rows[0]?.id === 'kimi-k3' && pins.rows.every(row => !row.listedLive && row.observedAt === '2026-08-21'))
  let clock = Date.now()
  const now = () => clock
  const epoch = catalogueEpoch()
  const first = c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch(), now })
  const second = c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch(), now })
  check('concurrent forced reads share one flight', first === second)
  const snapshot = await first
  check('one successful read bumps the shared catalogue epoch', calls.length === 1 && catalogueEpoch() === epoch + 1 && snapshot?.source === 'stored')
  const rows = c.moonshotCatalogueRows()
  check('live recency, not typed order, chooses the first row', rows.source.kind === 'live' && rows.rows.map(row => row.id).join(',') === 'kimi-fixture-next,kimi-k2.6')
  check('an untyped live row carries its own stated context', rows.rows[0]?.contextWindow === 524288 && rows.rows[0].listedLive)
  check('the picker reads only the fetched ids', keyLanePins('moonshot').map(row => row.id).join(',') === 'kimi-fixture-next,kimi-k2.6')
  resetComputedDefaultMemo()
  const choice = computedDefault()
  check('a newly signed-in family defaults to the newest served row', choice.setting === 'kimi-fixture-next' && choice.why.includes('live'), JSON.stringify(choice))
  check('the recommendation uses the live source, not a static frontier', providerFrontierFact('moonshot')?.modelId === 'kimi-fixture-next' && providerFrontierFact('moonshot')?.source === '2 models live')
  check('the adapter describes and lists the same live rows', describeMoonshotProvider().catalogueSource === 'live-discovery' && listMoonshotModels()[0]?.ref.model === 'kimi-fixture-next')
  const absent = await c.qualifyMoonshotModel('kimi-k3')
  check('a missing typed id refuses with the shared account-labelled sentence', absent.kind === 'refused' && absent.message === "model 'kimi-k3' is not offered by the Moonshot API key (stored, auth-scoped) live catalogue. The catalogue offers: kimi-fixture-next, kimi-k2.6.", JSON.stringify(absent))
  check('an untyped served id is admitted', (await c.qualifyMoonshotModel('kimi-fixture-next')).kind === 'ok')
  const { resolveEngineDispatch, engineDispatchModelsForSchema } = await import('../../src/utils/swarm/engineDispatch.ts')
  check('the specialist alias resolves the newest live row', (await resolveEngineDispatch('kimi'))?.model === 'kimi-fixture-next')
  check('a served untyped specialist id is admitted', (await resolveEngineDispatch('kimi-fixture-next'))?.model === 'kimi-fixture-next')
  const deadSpecialist = await resolveEngineDispatch('kimi-k3').then(() => '', error => String(error))
  check('a retired specialist id is refused by the same catalogue', deadSpecialist.includes("model 'kimi-k3' is not offered by the"))
  const advertised = engineDispatchModelsForSchema()
  check('the tool schema advertises live rows, not retired typed rows', advertised.includes('kimi-fixture-next') && !advertised.includes('kimi-k3'))
  const { validateModel } = await import('../../src/utils/model/validateModel.ts')
  check('typing a model reads the same live admission', (await validateModel('kimi-fixture-next')).valid && !(await validateModel('kimi-k3')).valid)
  clock += 1000
  await c.refreshMoonshotCatalogue({ fetchImpl: pageFetch(), now })
  check('the cache span prevents another request', calls.length === 1)
  clock += 300001
  await c.refreshMoonshotCatalogue({ fetchImpl: pageFetch(), now })
  check('the expired span refreshes', calls.length === 2)
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({}, 503), now })
  check('a failed refresh keeps the last good list, never the retired table', c.moonshotCatalogueRows().rows[0]?.id === 'kimi-fixture-next' && c.getCachedMoonshotCatalogue()?.lastError?.includes('HTTP 503') === true)
  const count = calls.length
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch(), now })
  check('the traffic-off gate prevents requests even for a forced refresh', calls.length === count)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  writeStoredMoonshotApiKey('fixture-stored-two')
  check('another credential cannot inherit the first account list', c.getCachedMoonshotCatalogue() === null)
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({ object: 'list', data: [] }), now })
  check('a successful empty list is authoritative, not a fallback', c.moonshotCatalogueRows().source.kind === 'live' && keyLanePins('moonshot').length === 0)
  check('an empty list refuses even a known typed id', (await c.qualifyMoonshotModel('kimi-k3')).kind === 'refused')
  writeStoredMoonshotApiKey('fixture-stored-three')
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({}, 503), now })
  const degraded = await c.qualifyMoonshotModel('kimi-fixture-named')
  check('with no successful list, an exact id proceeds with an explicit note', degraded.kind === 'degraded' && degraded.note.includes('unavailable') && degraded.note.includes("proceeding with 'kimi-fixture-named'"))
  check('a failed first read leaves the dated table, not an empty live catalogue', c.moonshotCatalogueRows().source.kind === 'pin')
  const failedCount = calls.length
  clock += 5000
  await c.refreshMoonshotCatalogue({ fetchImpl: pageFetch(), now })
  check('failure backoff prevents a tight retry loop', calls.length === failedCount)
  clock += 5001
  await c.refreshMoonshotCatalogue({ fetchImpl: pageFetch(), now })
  check('the failed read recovers after its own retry span', calls.length === failedCount + 1 && c.moonshotCatalogueRows().source.kind === 'live')
  writeMoonshotTokens({ accessToken: 'fixture-managed', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 86400000 }, 'mainland-cn')
  calls = []
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch() })
  check('a managed sign-in uses the coding base with its own bearer', calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:1/coding/models' && calls[0].bearer === 'Bearer fixture-managed' && c.getCachedMoonshotCatalogue()?.source === 'kimi-oauth')
  process.env.MOONSHOT_API_KEY = 'fixture-env'
  check('an env override cannot read the managed snapshot', c.getCachedMoonshotCatalogue() === null)
  calls = []
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch() })
  check('the env key wins on the platform base', calls[0]?.url === 'http://127.0.0.1:1/platform/models' && calls[0].bearer === 'Bearer fixture-env')
  process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/other'
  check('a base change cannot reuse another endpoint list', c.getCachedMoonshotCatalogue() === null)
  c.__resetMoonshotCatalogueForTest()
  let release: (() => void) | undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const priming = c.refreshMoonshotCatalogue({ force: true, fetchImpl: (async () => { await held; return Response.json(page) }) as typeof fetch })
  const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
  const controller = new AbortController()
  const turn = moonshotCallModel({ signal: controller.signal, options: { model: 'kimi-fixture-next' } } as never).next()
  controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelled = await Promise.race([turn.then(result => result.done === true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500) })])
  clearTimeout(timer)
  release?.()
  await priming
  await turn
  check('cancelling a chat never waits for a shared catalogue read', cancelled)
  c.__resetMoonshotCatalogueForTest()
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
