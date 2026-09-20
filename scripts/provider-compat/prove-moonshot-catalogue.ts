#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
  console.log('the reader against every list shape')
  delete process.env.MOONSHOT_API_KEY
  process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/platform'
  writeMoonshotTokens(null)
  writeStoredMoonshotApiKey('fixture-stored-review')
  const shapes: Array<{ name: string; fetchImpl: typeof fetch; error: string }> = [
    { name: 'a 401', fetchImpl: pageFetch({ error: { message: 'bad key' } }, 401), error: 'Moonshot models endpoint refused the credential (HTTP 401)' },
    { name: 'a 429', fetchImpl: pageFetch({ error: { message: 'slow down' } }, 429), error: 'Moonshot models endpoint returned HTTP 429' },
    { name: 'a 5xx', fetchImpl: pageFetch({ error: { message: 'down' } }, 502), error: 'Moonshot models endpoint returned HTTP 502' },
    { name: 'a 200 with a body that is not JSON', fetchImpl: (async () => new Response('<html>not a list</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch, error: 'the models endpoint answered a body that is not JSON' },
  ]
  for (const shape of shapes) {
    c.__resetMoonshotCatalogueForTest()
    await c.refreshMoonshotCatalogue({ force: true, fetchImpl: shape.fetchImpl })
    const snapshot = c.getCachedMoonshotCatalogue()
    const rows = c.moonshotCatalogueRows()
    resetComputedDefaultMemo()
    const choice = computedDefault()
    const verdict = await c.qualifyMoonshotModel('kimi-operator-named')
    check(`${shape.name}: the snapshot records the failure and no fetched list`, snapshot !== null && snapshot.fetchedAtMs === 0 && snapshot.models.length === 0 && (shape.error !== '' ? snapshot.lastError === shape.error : (snapshot.lastError ?? '').length > 0), JSON.stringify(snapshot))
    check(`${shape.name}: the picker reads the dated table`, rows.source.kind === 'pin' && rows.rows[0]?.id === 'kimi-k3' && keyLanePins('moonshot').every(row => !row.listedLive))
    check(`${shape.name}: the default names the dated row and says no live list`, choice.provider === 'moonshot' && choice.setting === 'kimi-k3' && choice.why.includes('observed 2026-08-21; no live list'), choice.why)
    check(`${shape.name}: an operator-named id proceeds with the degraded note carrying the reason`, verdict.kind === 'degraded' && verdict.note.startsWith('[moonshot] the live model catalogue is unavailable (') && (shape.error === '' || verdict.note.includes(shape.error)) && verdict.note.endsWith("— proceeding with 'kimi-operator-named'; the provider validates it at dispatch."), JSON.stringify(verdict))
  }
  c.__resetMoonshotCatalogueForTest()
  const odd = { object: 'list', data: [
    { id: 'kimi-extra', object: 'model', created: 300, owned_by: 'moonshot', context_length: 131072, supports_image_in: false, supports_video_in: false, supports_reasoning: false, unknown_field: { nested: true }, price: '9' },
    { id: 'kimi-bare' },
    { object: 'model', created: 400 },
    { id: 'kimi-k2.6', object: 'model', owned_by: 'moonshot', created: 100 },
  ] }
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch(odd) })
  const oddRows = c.moonshotCatalogueRows()
  check('extra fields are ignored and the row lands with its stated facts', oddRows.source.kind === 'live' && oddRows.rows.some(row => row.id === 'kimi-extra' && row.contextWindow === 131072 && row.listedLive), JSON.stringify(oddRows.rows))
  check('a row with only an id lands after every dated row, with no invented context', oddRows.rows.at(-1)?.id === 'kimi-bare' && oddRows.rows.at(-1)?.contextWindow === undefined)
  check('a row without an id is dropped, never a blank row', oddRows.rows.length === 3 && oddRows.rows.every(row => row.id.length > 0))
  check('a typed id the list serves keeps its recorded display name', oddRows.rows.find(row => row.id === 'kimi-k2.6')?.displayName === 'Kimi K2.6')
  const epochBefore = catalogueEpoch()
  resetComputedDefaultMemo()
  const beforeChange = computedDefault()
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({ object: 'list', data: [{ id: 'kimi-fixture-newer', object: 'model', created: 900, owned_by: 'moonshot' }, { id: 'kimi-k2.6', object: 'model', created: 100, owned_by: 'moonshot' }] }) })
  const afterChange = computedDefault()
  check('a list that changes between two reads bumps the epoch and moves the default to the newest served row', catalogueEpoch() === epochBefore + 1 && beforeChange.setting === 'kimi-extra' && afterChange.setting === 'kimi-fixture-newer', JSON.stringify({ before: beforeChange.setting, after: afterChange.setting }))
  check('an id the changed list no longer serves is refused at the next admission', (await c.qualifyMoonshotModel('kimi-extra')).kind === 'refused')
  c.__resetMoonshotCatalogueForTest()
  const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }) })) as typeof fetch
  const slowStart = Date.now()
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: hanging })
  const slow = c.getCachedMoonshotCatalogue()
  check("a list that never answers ends at the provider deadline with the honest line, never the runtime's abort spelling", slow?.lastError === 'timed out after 15s — moonshot did not answer' && slow.fetchedAtMs === 0 && Date.now() - slowStart < 20000, JSON.stringify({ lastError: slow?.lastError, ms: Date.now() - slowStart }))
  console.log('the choosers with a list present, absent, empty, or lacking every typed row')
  c.__resetMoonshotCatalogueForTest()
  resetComputedDefaultMemo()
  const absentWorld = computedDefault()
  check('absent: the dated row is the default with the observation words; the picker and the adapter carry the dated rows', absentWorld.setting === 'kimi-k3' && absentWorld.why.includes('observed 2026-08-21; no live list') && keyLanePins('moonshot').every(row => !row.listedLive) && listMoonshotModels()[0]?.ref.model === 'kimi-k3' && describeMoonshotProvider().catalogueSource === 'static-pin', absentWorld.why)
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({ object: 'list', data: [] }) })
  resetComputedDefaultMemo()
  const emptyChoice = computedDefault()
  check('empty: no Moonshot row is usable, the default leaves the family, the picker and the adapter list nothing', emptyChoice.provider !== 'moonshot' && emptyChoice.considered.find(entry => entry.family === 'moonshot')?.verdict.usable === false && keyLanePins('moonshot').length === 0 && listMoonshotModels().length === 0, JSON.stringify({ provider: emptyChoice.provider, considered: emptyChoice.considered.map(entry => [entry.family, entry.verdict.usable]) }))
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch({ object: 'list', data: [{ id: 'kimi-untyped-b', object: 'model', created: 10, owned_by: 'moonshot' }, { id: 'kimi-untyped-a', object: 'model', created: 20, owned_by: 'moonshot' }] }) })
  resetComputedDefaultMemo()
  const untyped = computedDefault()
  check('lacking every typed row: the served rows stand under mechanical names, the newest is the default, the adapter agrees', untyped.setting === 'kimi-untyped-a' && untyped.row === 'Kimi Untyped A' && keyLanePins('moonshot').map(row => row.id).join(',') === 'kimi-untyped-a,kimi-untyped-b' && listMoonshotModels()[0]?.ref.model === 'kimi-untyped-a', JSON.stringify({ setting: untyped.setting, row: untyped.row }))
  console.log('the unnamed-default boundary reads once, never for an explicit choice, never past the allowance')
  const { readComputedDefaultCatalogue, mostRecentSignInFamily } = await import('../../src/utils/model/computedDefault.ts')
  const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
  const { CATALOGUE_READ_BOUND_MS } = await import('../../src/services/providers/catalogueOnDemand.ts')
  const { getUserSpecifiedModelSetting, normalizeModelStringForAPI } = await import('../../src/utils/model/model.ts')
  recordSignIn('moonshot', 'api-key')
  c.__resetMoonshotCatalogueForTest()
  process.env.MERCURY_MODEL = 'kimi-k2.6'
  await readComputedDefaultCatalogue()
  check('an explicit environment choice makes no list request at the boundary', getUserSpecifiedModelSetting() === 'kimi-k2.6' && c.getCachedMoonshotCatalogue() === null)
  delete process.env.MERCURY_MODEL
  let blackRequests = 0
  const black = createServer(() => { blackRequests++ })
  await new Promise<void>(resolve => black.listen(0, '127.0.0.1', resolve))
  const blackPort = (black.address() as { port: number }).port
  process.env.MERCURY_MOONSHOT_API_BASE = `http://127.0.0.1:${blackPort}/platform`
  c.__resetMoonshotCatalogueForTest()
  check('the world is the unnamed-default one: no explicit choice, Moonshot the most recent sign-in', getUserSpecifiedModelSetting() === null && mostRecentSignInFamily() === 'moonshot', `${String(getUserSpecifiedModelSetting())} ${String(mostRecentSignInFamily())}`)
  const boundaryStart = Date.now()
  await readComputedDefaultCatalogue()
  const boundaryWait = Date.now() - boundaryStart
  check('a list that never answers holds the boundary no longer than the catalogue allowance', boundaryWait < CATALOGUE_READ_BOUND_MS + 2000, `${boundaryWait} ms against ${CATALOGUE_READ_BOUND_MS}`)
  check('the boundary made exactly one request, and the read is still in flight behind it', blackRequests === 1 && c.getCachedMoonshotCatalogue() === null, `${blackRequests} request(s)`)
  black.closeAllConnections()
  await new Promise<void>(resolve => black.close(() => resolve()))
  process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/platform'
  const birthSource = readFileSync(join(import.meta.dir, '../../src/services/switchboard/bornSession.ts'), 'utf8')
  const printSource = readFileSync(join(import.meta.dir, '../../src/main.tsx'), 'utf8')
  const guardedRead = "const { readComputedDefaultCatalogue } = await import('../../utils/model/computedDefault.js')\n    await readComputedDefaultCatalogue()"
  check('the cockpit birth reads the list only when neither the record nor the door names a model', birthSource.includes(`if (facts.model === null && (req.model ?? null) === null) {\n    ${guardedRead}\n  }`))
  const printSet = 'setInitialMainLoopModel(userSpecifiedModel ?? null)'
  const printRead = "if (printMode) {\n    const { readComputedDefaultCatalogue } = await import('./utils/model/computedDefault.js')\n    await readComputedDefaultCatalogue()\n  }"
  check('the print seat reads it after the explicit choices are set, through the same guarded owner', printSource.includes(printRead) && printSource.includes(printSet) && printSource.indexOf(printSet) < printSource.indexOf(printRead))
  console.log('the admission against the landed list')
  c.__resetMoonshotCatalogueForTest()
  await c.refreshMoonshotCatalogue({ force: true, fetchImpl: pageFetch() })
  const named = await c.qualifyMoonshotModel('kimi-operator-named')
  check('an operator-named id the landed list lacks is refused with the shared sentence naming the served ids', named.kind === 'refused' && named.message === "model 'kimi-operator-named' is not offered by the Moonshot API key (stored, auth-scoped) live catalogue. The catalogue offers: kimi-fixture-next, kimi-k2.6.", JSON.stringify(named))
  check('a served id spelled in upper case is admitted', (await c.qualifyMoonshotModel('KIMI-FIXTURE-NEXT')).kind === 'ok')
  check('the call road strips a window annotation before the admission, and the raw spelling alone is not a served id', (await c.qualifyMoonshotModel(normalizeModelStringForAPI('kimi-fixture-next[1m]'))).kind === 'ok' && (await c.qualifyMoonshotModel('kimi-fixture-next[1m]')).kind === 'refused')
  const admissionOwner = readFileSync(join(import.meta.dir, '../../src/services/providers/catalogueAdmission.ts'), 'utf8')
  const gptRoad = readFileSync(join(import.meta.dir, '../../src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  const moonshotRoad = readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotCatalogue.ts'), 'utf8')
  check('the refusal sentence has one owner, imported by both admission roads and spelled by neither', admissionOwner.includes('is not offered by the ${accountLabel} live catalogue.') && gptRoad.includes("import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'") && moonshotRoad.includes("import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'") && !gptRoad.includes('is not offered by the') && !moonshotRoad.includes('is not offered by the'))
  console.log('two chats on one held refresh')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const chatParams = (signal: AbortSignal): Parameters<typeof moonshotCallModel>[0] => ({
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: ['fixture system prompt'],
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'kimi-fixture-next', isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' },
  }) as never
  c.__resetMoonshotCatalogueForTest()
  let releaseTwo: (() => void) | undefined
  const heldTwo = new Promise<void>(resolve => { releaseTwo = resolve })
  const primingTwo = c.refreshMoonshotCatalogue({ force: true, fetchImpl: (async () => { await heldTwo; return Response.json(page) }) as typeof fetch })
  const firstChat = new AbortController()
  const secondChat = new AbortController()
  const turnOne = moonshotCallModel(chatParams(firstChat.signal)).next()
  const turnTwo = moonshotCallModel(chatParams(secondChat.signal)).next()
  firstChat.abort()
  let timerOne: ReturnType<typeof setTimeout> | undefined
  const oneEnded = await Promise.race([turnOne.then(result => result.done === true), new Promise<boolean>(resolve => { timerOne = setTimeout(() => resolve(false), 500) })])
  clearTimeout(timerOne)
  let timerTwo: ReturnType<typeof setTimeout> | undefined
  const twoWaits = await Promise.race([turnTwo.then(() => false), new Promise<boolean>(resolve => { timerTwo = setTimeout(() => resolve(true), 200) })])
  clearTimeout(timerTwo)
  releaseTwo?.()
  await primingTwo
  const two = await turnTwo.then(result => ({ done: result.done === true, text: JSON.stringify(result.value ?? null) }), error => ({ done: true, text: `threw ${String(error)}` }))
  check('the cancelled chat ends at once while the other keeps waiting on the shared read', oneEnded && twoWaits)
  check('the shared refresh outlives the cancelled chat: it lands, and the second chat proceeds past the admission to its wire', (c.getCachedMoonshotCatalogue()?.fetchedAtMs ?? 0) > 0 && !two.done && !two.text.includes('is not offered by the') && !two.text.includes('catalogue is unavailable'), two.text.slice(0, 300))
  console.log('the degraded note rides the settled message')
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
  let chatStatus = 200
  const chatFixture = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    req.on('data', () => {})
    req.on('end', () => {
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        if (chatStatus !== 200) {
          res.writeHead(chatStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture answer' } }] }) + sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + 'data: [DONE]\n\n')
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => chatFixture.listen(0, '127.0.0.1', resolve))
  const chatPort = (chatFixture.address() as { port: number }).port
  process.env.MERCURY_MOONSHOT_API_BASE = `http://127.0.0.1:${chatPort}/platform/v1`
  c.__resetMoonshotCatalogueForTest()
  type SettledItem = { id: string; api: boolean; text: string }
  const collect = async (items: AsyncGenerator<unknown>): Promise<SettledItem[]> => {
    const out: SettledItem[] = []
    for await (const item of items) {
      if ((item as { type?: string }).type !== 'assistant') continue
      const message = item as { isApiErrorMessage?: boolean; message: { id: string; content: Array<{ type: string; text?: string }> } }
      out.push({ id: message.message.id, api: message.isApiErrorMessage === true, text: message.message.content.map(block => block.text ?? '').join('') })
    }
    return out
  }
  const degradedTurn = await collect(moonshotCallModel(chatParams(new AbortController().signal)))
  const degradedNote = "[moonshot] the live model catalogue is unavailable (Moonshot models endpoint returned HTTP 502) — proceeding with 'kimi-fixture-next'; the provider validates it at dispatch."
  check('a degraded chat settles once: the note is the first block of the one settled message and the answer follows it', degradedTurn.length >= 2 && new Set(degradedTurn.map(item => item.id)).size === 1 && degradedTurn[0]?.text === degradedNote && degradedTurn.some(item => item.text === 'fixture answer') && degradedTurn.every(item => !item.api), JSON.stringify(degradedTurn))
  chatStatus = 401
  c.__resetMoonshotCatalogueForTest()
  const refusedTurn = await collect(moonshotCallModel(chatParams(new AbortController().signal)))
  check('a refusal after a degraded admission is one message, the refusal, with no note before it', refusedTurn.length === 1 && refusedTurn[0]?.api === true && !refusedTurn.some(item => item.text.includes('catalogue is unavailable')), JSON.stringify(refusedTurn))
  chatStatus = 200
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
  const plainTurn = await collect(compatChatCallModel(moonshotLaneProfile, chatParams(new AbortController().signal)))
  check('a profile without the seam is the road as it was: the answer is the first settled block and no note rides', plainTurn[0]?.text === 'fixture answer' && !plainTurn.some(item => item.text.includes('catalogue is unavailable')), JSON.stringify(plainTurn))
  const runtimeSource = readFileSync(join(import.meta.dir, '../../src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the seam is read through one default of nothing, so an absent field is the road as it was', runtimeSource.includes('ctx.leadingNotes ?? []') && !readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotCallModel.ts'), 'utf8').includes('createAssistantMessage'))
  chatFixture.closeAllConnections()
  await new Promise<void>(resolve => chatFixture.close(() => resolve()))
  process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/platform'
  c.__resetMoonshotCatalogueForTest()
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
