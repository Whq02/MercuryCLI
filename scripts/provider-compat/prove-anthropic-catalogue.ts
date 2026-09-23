#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'anthropic-catalogue-proof-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_BASE_URL = 'https://anthropic.fixture.invalid'
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'CI',
  'NODE_ENV',
]) {
  delete process.env[key]
}
const FIXTURE_KEY = 'proof-key-ci-gate-not-a-real-key'
const SUBSCRIPTION_TOKEN = 'fixture-access-token-000000000001'
const BEARER_TOKEN = 'fixture-env-bearer-token-00000001'
writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, theme: 'dark', customApiKeyResponses: { approved: [FIXTURE_KEY.slice(-20)], rejected: [] } }))
writeFileSync(join(HOME, 'settings.json'), '{}')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const catalogue = await import('../../src/services/providers/anthropic/anthropicCatalogue.ts').catch(() => null)
const { catalogueTrafficVerdict, connectToBrowseReason } = await import('../../src/services/providers/catalogueGate.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { clearOAuthTokenCache } = await import('../../src/utils/auth.ts')
const { OAUTH_BETA_HEADER } = await import('../../src/constants/oauth.ts')

type Call = { url: string; headers: Record<string, string> }
const KEY_LIST = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5-7']
const SUBSCRIPTION_LIST = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2']
const page = (ids: string[], hasMore = false, lastId?: string): unknown => ({
  data: ids.map(id => ({ type: 'model', id, display_name: `Claude ${id.replace('claude-', '')}`, created_at: '2026-09-01T00:00:00Z' })),
  has_more: hasMore,
  ...(lastId !== undefined ? { last_id: lastId } : {}),
})
function doorFetch(opts: {
  calls?: Call[]
  keyStatus?: number
  subscriptionStatus?: number
  bearerStatus?: number
  keyPages?: unknown[]
}): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }
    opts.calls?.push({ url: String(url), headers })
    if (!String(url).includes('/v1/models')) return jsonResponse(404, {})
    const authorization = headers.authorization ?? ''
    if (headers['x-api-key'] !== undefined) {
      if (opts.keyStatus !== undefined) return jsonResponse(opts.keyStatus, { error: { message: `fixture ${opts.keyStatus}` } })
      if (opts.keyPages) {
        const after = new URL(String(url)).searchParams.get('after_id')
        return jsonResponse(200, after === null ? opts.keyPages[0] : opts.keyPages[1])
      }
      return jsonResponse(200, page(KEY_LIST))
    }
    if (authorization === `Bearer ${SUBSCRIPTION_TOKEN}`) {
      if (opts.subscriptionStatus !== undefined) return jsonResponse(opts.subscriptionStatus, { error: { message: `fixture ${opts.subscriptionStatus}` } })
      return jsonResponse(200, page(SUBSCRIPTION_LIST))
    }
    if (authorization === `Bearer ${BEARER_TOKEN}`) {
      return jsonResponse(opts.bearerStatus ?? 403, { error: { type: 'permission_error', message: 'fixture refuses the bearer' } })
    }
    return jsonResponse(401, { error: { type: 'authentication_error', message: 'no credential' } })
  }) as typeof fetch
}
const seedSubscription = (expiresAt: number): void => {
  writeFileSync(
    join(HOME, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: SUBSCRIPTION_TOKEN,
        refreshToken: 'fixture-refresh-token-00000000001',
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }),
  )
  clearOAuthTokenCache()
}
const dropSubscription = (): void => {
  rmSync(join(HOME, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

section('1 · no credential: no door, the gate refuses, nothing is read')
if (!catalogue) {
  check('the catalogue module exists', false, 'src/services/providers/anthropic/anthropicCatalogue.ts is absent')
} else {
  check('no signed-in door', catalogue.anthropicDoors().length === 0, JSON.stringify(catalogue.anthropicDoors().map(d => d.door)))
  const verdict = catalogueTrafficVerdict('anthropic')
  check('the door knows the Anthropic family and refuses without a credential, in the shared words', verdict.allowed === false && (verdict as { reason?: string }).reason === `${connectToBrowseReason('anthropic')} — /logins connects`, JSON.stringify(verdict))
  const calls: Call[] = []
  const closed = await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls }) })
  check('a refresh with no door makes no request and lands nothing', closed.length === 0 && calls.length === 0)
  check('the kick starts nothing', catalogue.kickAnthropicCatalogue({ fetchImpl: doorFetch({ calls }) }) === false && calls.length === 0)
  check('the union is empty and no door has a state', catalogue.anthropicLiveUnion().length === 0 && catalogue.anthropicCatalogueDoorStates().length === 0)
}

section('2 · the fetch: the vendor page shape, the headers the wire sends, pagination, the honest failures')
if (catalogue) {
  const rows = (page(['claude-opus-5-5']) as { data: unknown[] }).data.map(catalogue.decodeAnthropicModel)
  check('the vendor row decodes to its id, display name and created_at', rows[0]?.id === 'claude-opus-5-5' && rows[0]?.displayName === 'Claude opus-5-5' && rows[0]?.createdAt === '2026-09-01T00:00:00Z', JSON.stringify(rows))
  check('a row without an id is skipped; an unstated name stays absent', catalogue.decodeAnthropicModel({ type: 'model' }) === undefined && catalogue.decodeAnthropicModel({ id: 'claude-x' })?.displayName === undefined)
  const calls: Call[] = []
  const landed = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid/', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: doorFetch({ calls }) })
  check('one GET {base}/v1/models?limit=1000 with anthropic-version 2023-06-01, accept json, the product agent and the door credential', calls.length === 1 && calls[0]?.url === 'https://anthropic.fixture.invalid/v1/models?limit=1000' && calls[0].headers['anthropic-version'] === '2023-06-01' && calls[0].headers.accept === 'application/json' && (calls[0].headers['user-agent'] ?? '').startsWith('mercury/') && calls[0].headers['x-api-key'] === FIXTURE_KEY, JSON.stringify(calls))
  check('the page lands as its rows with a stamp', landed.models.map(m => m.id).join(',') === KEY_LIST.join(',') && landed.fetchedAtMs > 0)
  const paged: Call[] = []
  const twoPages = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: doorFetch({ calls: paged, keyPages: [page(['claude-opus-5-5'], true, 'claude-opus-5-5'), page(['claude-haiku-5'])] }) })
  check('has_more walks the pages by after_id=last_id and joins them in order', twoPages.models.map(m => m.id).join(',') === 'claude-opus-5-5,claude-haiku-5' && paged.length === 2 && paged[1]?.url.includes('after_id=claude-opus-5-5') === true, JSON.stringify(paged.map(c => c.url)))
  const refused = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: doorFetch({ keyStatus: 401 }) }).then(() => '', (e: Error) => e.message)
  check('a 401 names a refused credential', refused === 'anthropic models endpoint refused the credential (HTTP 401)', refused)
  const missing = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: doorFetch({ keyStatus: 404 }) }).then(() => '', (e: Error) => e.message)
  check('a 404 names the status (a door that serves no list)', missing === 'anthropic models endpoint returned HTTP 404', missing)
  const htmlFetch = (async () => new Response('<html>not a list</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
  const notJson = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: htmlFetch }).then(() => '', (e: Error) => e.message)
  check('a 200 with a body that is not JSON reads the shared sentence', notJson === 'the models endpoint answered a body that is not JSON', notJson)
  const dead = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'http://127.0.0.1:1', headers: { 'x-api-key': FIXTURE_KEY } }).then(() => '', (e: Error) => e.message)
  check("a dead base through this runtime's own fetch reads the shared unreachable sentence with a code inside", /^the models endpoint could not be reached \([^()]+\)$/.test(dead), dead)
  const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }) })) as typeof fetch
  const slowStart = Date.now()
  const slow = await catalogue.fetchAnthropicLiveModels({ baseUrl: 'https://anthropic.fixture.invalid', headers: { 'x-api-key': FIXTURE_KEY }, fetchImpl: hanging }).then(() => '', (e: Error) => e.message)
  check('a list that never answers ends at the provider deadline with the honest line', slow === 'timed out after 15s — anthropic did not answer' && Date.now() - slowStart < 20_000, JSON.stringify({ slow, ms: Date.now() - slowStart }))
}

section('3 · one door (the API key): the snapshot, the TTL, single-flight, the failure label, the traffic switch, the kick')
if (catalogue) {
  process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
  catalogue.__resetAnthropicCatalogueForTest()
  const doors = catalogue.anthropicDoors()
  check('the API key is the one signed-in door', doors.map(d => d.door).join(',') === 'api-key' && doors[0]?.label === 'Anthropic API key' && doors[0].headers['x-api-key'] === FIXTURE_KEY && doors[0].headers.authorization === undefined, JSON.stringify(doors.map(d => [d.door, Object.keys(d.headers)])))
  check('the gate opens on the credential', catalogueTrafficVerdict('anthropic').allowed === true)
  check('nothing cached: the door is pending and the union empty', catalogue.anthropicCatalogueDoorStates().map(s => s.state).join(',') === 'pending' && catalogue.anthropicLiveUnion().length === 0)
  let t = 1_000_000
  const now = () => t
  const calls: Call[] = []
  const e0 = catalogueEpoch()
  const [snapshot] = await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls }), now })
  check('one request under the key header, the snapshot keyed to the door with the rows and the stamp', calls.length === 1 && calls[0]?.headers['x-api-key'] === FIXTURE_KEY && snapshot?.door === 'api-key' && snapshot.models.length === 3 && snapshot.fetchedAtMs === t, JSON.stringify(snapshot))
  check('the landing bumped the catalogue epoch once', catalogueEpoch() === e0 + 1, `${e0} → ${catalogueEpoch()}`)
  check('the cache read answers the same snapshot', catalogue.getCachedAnthropicDoorCatalogue('api-key') === snapshot)
  check('the door reads ready with its count and stamp', JSON.stringify(catalogue.anthropicCatalogueDoorStates()) === JSON.stringify([{ door: 'api-key', label: 'Anthropic API key', state: 'ready', count: 3, fetchedAtMs: t }]), JSON.stringify(catalogue.anthropicCatalogueDoorStates()))
  check('the union is the list in the vendor order, each row naming the door and the vendor name', catalogue.anthropicLiveUnion().map(r => `${r.id}:${r.doors.join('+')}:${r.displayName ?? ''}`).join(',') === KEY_LIST.map(id => `${id}:Anthropic API key:Claude ${id.replace('claude-', '')}`).join(','), JSON.stringify(catalogue.anthropicLiveUnion()))
  check('a listed id is found case-insensitively with its rider detached', catalogue.anthropicListedModel('Claude-Opus-5-7[1m]')?.id === 'claude-opus-5-7' && catalogue.anthropicListedModel('claude-opus-6') === undefined)
  t += 1_000
  await catalogue.refreshAnthropicCatalogue({ fetchImpl: doorFetch({ calls }), now })
  check('inside the TTL a refresh makes no request', calls.length === 1)
  t += 5 * 60_000
  await catalogue.refreshAnthropicCatalogue({ fetchImpl: doorFetch({ calls }), now })
  check('past the TTL it fetches again', calls.length === 2)
  const e1 = catalogueEpoch()
  check('an unchanged landing bumps nothing', e1 === e0 + 1, `${e0 + 1} vs ${e1}`)
  const concurrent: Call[] = []
  await Promise.all([
    catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls: concurrent }), now }),
    catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls: concurrent }), now }),
  ])
  check('two concurrent refreshes make one request (single-flight)', concurrent.length === 1, String(concurrent.length))
  const e2 = catalogueEpoch()
  const [failed] = await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ keyStatus: 503 }), now })
  check('a failed refresh keeps the rows, labels the error with its status and bumps the epoch', failed?.models.length === 3 && failed.lastError === 'anthropic models endpoint returned HTTP 503' && failed.lastStatus === 503 && catalogueEpoch() === e2 + 1, JSON.stringify(failed))
  check('the door still reads ready (stale but labelled) with the error beside it', catalogue.anthropicCatalogueDoorStates()[0]?.state === 'ready' && (catalogue.anthropicCatalogueDoorStates()[0] as { lastError?: string }).lastError === 'anthropic models endpoint returned HTTP 503')
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const dark: Call[] = []
  const darkSnapshots = await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls: dark }), now })
  check('traffic off: no request, the cached snapshot keeps serving', dark.length === 0 && darkSnapshots[0]?.models.length === 3 && catalogueTrafficVerdict('anthropic').allowed === false)
  check('traffic off: the kick starts nothing', catalogue.kickAnthropicCatalogue({ fetchImpl: doorFetch({ calls: dark }) }) === false && dark.length === 0)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  catalogue.__resetAnthropicCatalogueForTest()
  const kicked: Call[] = []
  const started = catalogue.kickAnthropicCatalogue({ fetchImpl: doorFetch({ calls: kicked }) })
  await settle()
  check('with a door and nothing cached the kick starts one refresh and the rows land', started === true && kicked.length === 1 && catalogue.getCachedAnthropicDoorCatalogue('api-key')?.models.length === 3)
  check('with rows cached the kick starts nothing', catalogue.kickAnthropicCatalogue({ fetchImpl: doorFetch({ calls: kicked }) }) === false && kicked.length === 1)
  catalogue.__resetAnthropicCatalogueForTest()
  t = 2_000_000
  await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ keyStatus: 503 }), now })
  check('a failed first read with no rows leaves the door in error with the attempt stamp', catalogue.anthropicCatalogueDoorStates()[0]?.state === 'error' && (catalogue.anthropicCatalogueDoorStates()[0] as { lastAttemptAtMs: number }).lastAttemptAtMs === t)
  const retry: Call[] = []
  t += 5_000
  await catalogue.refreshAnthropicCatalogue({ fetchImpl: doorFetch({ calls: retry }), now })
  check('inside the failure window a refresh asks nothing', retry.length === 0)
  t += 6_000
  await catalogue.refreshAnthropicCatalogue({ fetchImpl: doorFetch({ calls: retry }), now })
  check('past the failure window it asks again and lands', retry.length === 1 && catalogue.getCachedAnthropicDoorCatalogue('api-key')?.models.length === 3)
}

section('4 · every signed-in door lists live: the subscription bearer, the API key and an env bearer, each under its own credential')
if (catalogue) {
  catalogue.__resetAnthropicCatalogueForTest()
  seedSubscription(4102444800000)
  process.env.ANTHROPIC_AUTH_TOKEN = BEARER_TOKEN
  const doors = catalogue.anthropicDoors()
  check('three doors, subscription first', doors.map(d => d.door).join(',') === 'subscription,api-key,bearer', doors.map(d => d.door).join(','))
  check('the subscription door carries the bearer and the OAuth beta, the key door x-api-key, the env bearer the bearer alone', doors[0]?.headers.authorization === `Bearer ${SUBSCRIPTION_TOKEN}` && doors[0].headers['anthropic-beta'] === OAUTH_BETA_HEADER && doors[1]?.headers['x-api-key'] === FIXTURE_KEY && doors[1].headers['anthropic-beta'] === undefined && doors[2]?.headers.authorization === `Bearer ${BEARER_TOKEN}` && doors[2].headers['anthropic-beta'] === undefined, JSON.stringify(doors.map(d => Object.keys(d.headers))))
  const calls: Call[] = []
  const e0 = catalogueEpoch()
  const snapshots = await catalogue.refreshAnthropicCatalogue({ force: true, fetchImpl: doorFetch({ calls }) })
  check('one request per door, each under its own credential', calls.length === 3 && calls.some(c => c.headers.authorization === `Bearer ${SUBSCRIPTION_TOKEN}`) && calls.some(c => c.headers['x-api-key'] === FIXTURE_KEY) && calls.some(c => c.headers.authorization === `Bearer ${BEARER_TOKEN}`), JSON.stringify(calls.map(c => Object.keys(c.headers))))
  check('a snapshot per door: the two served doors carry their lists, the refused door its error', snapshots.length === 3 && snapshots[0]?.door === 'subscription' && snapshots[0].models.length === 3 && snapshots[1]?.door === 'api-key' && snapshots[1].models.length === 3 && snapshots[2]?.door === 'bearer' && snapshots[2].models.length === 0 && snapshots[2].lastError === 'anthropic models endpoint refused the credential (HTTP 403)', JSON.stringify(snapshots.map(s => [s.door, s.models.length, s.lastError])))
  check('the epoch bumped once per landing', catalogueEpoch() === e0 + 3, `${e0} → ${catalogueEpoch()}`)
  const states = catalogue.anthropicCatalogueDoorStates()
  check('the door states: ready 3, ready 3, error (HTTP 403)', states.map(s => `${s.door}:${s.state}${s.state === 'ready' ? `:${s.count}` : s.state === 'error' ? `:${s.lastStatus}` : ''}`).join(',') === 'subscription:ready:3,api-key:ready:3,bearer:error:403', JSON.stringify(states))
  const union = catalogue.anthropicLiveUnion()
  check("the union is the subscription's list in its order, then the key's new ids, each naming every door that listed it", union.map(r => `${r.id}:${r.doors.join('+')}`).join(',') === 'claude-opus-5-5:Claude subscription+Anthropic API key,claude-fable-5-1:Claude subscription,claude-fable-5-2:Claude subscription,claude-sonnet-5:Anthropic API key,claude-opus-5-7:Anthropic API key', JSON.stringify(union))
  catalogue.__resetAnthropicCatalogueForTest()
  const kicked: Call[] = []
  check('the kick starts a refresh for every pending door', catalogue.kickAnthropicCatalogue({ fetchImpl: doorFetch({ calls: kicked }) }) === true)
  await settle()
  check('three requests, one per door', kicked.length === 3, String(kicked.length))
  const bearerBefore = catalogue.getCachedAnthropicDoorCatalogue('bearer')
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-env-bearer-token-00000002'
  check('a different bearer is a different catalogue: nothing cached for it', bearerBefore !== null && catalogue.getCachedAnthropicDoorCatalogue('bearer') === null)
  process.env.ANTHROPIC_AUTH_TOKEN = BEARER_TOKEN
  check('the first bearer reads its own snapshot again', catalogue.getCachedAnthropicDoorCatalogue('bearer') === bearerBefore)
  delete process.env.ANTHROPIC_AUTH_TOKEN
  check('an env bearer removed is a door gone: two doors, and its snapshot no longer read', catalogue.anthropicDoors().length === 2 && catalogue.anthropicCatalogueDoorStates().length === 2)
  catalogue.__resetAnthropicCatalogueForTest()
  seedSubscription(Date.now() - 60_000)
  const stale: Call[] = []
  const expired = await catalogue.refreshAnthropicCatalogue({ force: true, door: 'subscription', fetchImpl: doorFetch({ calls: stale }) })
  check('an expired subscription token asks nothing and reads the honest error', stale.length === 0 && expired[0]?.lastError === catalogue.ANTHROPIC_TOKEN_EXPIRED_WORDS && catalogue.anthropicCatalogueDoorStates()[0]?.state === 'error', JSON.stringify(expired))
  const keyOnly = await catalogue.refreshAnthropicCatalogue({ force: true, door: 'api-key', fetchImpl: doorFetch({ calls: stale }) })
  check('the key door still lists on its own', keyOnly[0]?.models.length === 3 && catalogue.anthropicLiveUnion().map(r => r.id).join(',') === KEY_LIST.join(','))
  dropSubscription()
  check('the subscription signed out is a door gone', catalogue.anthropicDoors().map(d => d.door).join(',') === 'api-key')
}

section('5 · the dead base: the door reads error, no row of the static picker moves')
if (catalogue) {
  catalogue.__resetAnthropicCatalogueForTest()
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
  const { getModelOptions, ANTHROPIC_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
  const anthropicRows = (): string[] =>
    getModelOptions({ anthropicCredentialed: () => true })
      .filter(o => o.group === undefined || o.group === ANTHROPIC_MODEL_GROUP)
      .map(o => o.value)
  const before = anthropicRows()
  const [snapshot] = await catalogue.refreshAnthropicCatalogue({ force: true })
  check('the dead base is a catalogue error for the door, named', snapshot?.models.length === 0 && /^the models endpoint could not be reached \(/.test(snapshot?.lastError ?? '') && catalogue.anthropicCatalogueDoorStates()[0]?.state === 'error', JSON.stringify(snapshot))
  check('the static rows stand exactly as before the read', anthropicRows().join(',') === before.join(',') && before.length > 0, anthropicRows().join(','))
  catalogue.__resetAnthropicCatalogueForTest()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ ANTHROPIC CATALOGUE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
