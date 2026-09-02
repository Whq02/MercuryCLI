#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — OpenRouter live catalogue + key usage (fixtures)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENROUTER_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-openrouter-cat-'))
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'

const catalogue = await import('../../src/services/providers/openrouter/openrouterCatalogue.js')
const usageState = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
const {
  __resetOpenrouterCatalogueForTest,
  getCachedOpenrouterCatalogue,
  getOpenrouterAvailability,
  getOpenrouterModelOptions,
  openrouterDispatchReady,
  openrouterModelsForVendor,
  refreshOpenrouterCatalogue,
} = catalogue
const {
  __resetOpenrouterUsageStateForTest,
  openrouterLimitWindow,
  openrouterObservedKeyUsage,
  recordOpenrouterRateHeaders,
  refreshOpenrouterKeyUsage,
} = usageState
const providerUsage = await import('../../src/services/providers/providerUsage.js')

const PAGE_ONE = {
  data: [
    {
      id: 'anthropic/claude-fixture',
      name: 'Claude Fixture',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'temperature'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      top_provider: { max_completion_tokens: 64000 },
      created: 1755000000,
    },
    { id: 'google/gemini-fixture', name: 'Gemini Fixture' },
    { not_a_model: true },
  ],
  total_count: 4,
  links: { next: '/api/v1/models?offset=3&limit=1000' },
}
const PAGE_TWO = {
  data: [
    { id: 'openai/gpt-fixture', name: 'GPT Fixture', expiration_date: '2026-12-01' },
    { id: 'anthropic/claude-opus-5[1m]', name: 'Claude Opus 5 (1M)' },
  ],
  total_count: 5,
  links: { next: null },
}

function pagedFetch(counter: { calls: string[] }): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url)
    counter.calls.push(u)
    const body = u.includes('offset=3') ? PAGE_TWO : PAGE_ONE
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

{
  __resetOpenrouterCatalogueForTest()
  const availability = getOpenrouterAvailability()
  check('no credential ⇒ disabled/no-account', availability.state === 'disabled' && availability.why === 'no-account')
  const rows = getOpenrouterModelOptions()
  check('signed-out picker = ONE connect action row, zero invented pins', rows.length === 1 && rows[0]!.value === '__mercury_openrouter_connect__' && rows[0]!.label === 'OpenRouter — sign in')
}

process.env.OPENROUTER_API_KEY = 'sk-or-v1-PROVERKEY000000000000'
{
  __resetOpenrouterCatalogueForTest()
  const counter = { calls: [] as string[] }
  const snapshot = await refreshOpenrouterCatalogue('env', { fetchImpl: pagedFetch(counter) })
  check('both pages fetched from the PINNED base', counter.calls.length === 2 && counter.calls.every(u => u.startsWith('https://fixture.invalid/')))
  check('first call asks the vendor for most-popular order', counter.calls[0]!.includes('sort=most-popular'))
  check('4 decodable models across pages, order preserved', snapshot?.models.length === 4 && snapshot.models[0]!.id === 'anthropic/claude-fixture' && snapshot.models[2]!.id === 'openai/gpt-fixture')
  const first = snapshot!.models[0]!
  check('stated fields decoded (context, pricing, params, modalities, maxOut)', first.contextLength === 200000 && first.pricing?.prompt === '0.000003' && first.supportedParameters?.includes('tools') && first.maxCompletionTokens === 64000)
  const bare = snapshot!.models[1]!
  check('absent fields stay ABSENT — never zero', bare.contextLength === undefined && bare.pricing === undefined)
  check('expiration_date rides the decode', snapshot!.models[2]!.expirationDate === '2026-12-01')

  const counter2 = { calls: [] as string[] }
  await refreshOpenrouterCatalogue('env', { fetchImpl: pagedFetch(counter2) })
  check('TTL cache: second refresh inside the window fetches NOTHING', counter2.calls.length === 0)
}

{
  const failing: typeof fetch = (async () => {
    throw new Error('fixture network down')
  }) as unknown as typeof fetch
  const snapshot = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: failing })
  check('failed refresh keeps stale models + labels lastError', snapshot?.models.length === 4 && snapshot?.lastError === 'fixture network down')
  const availability = getOpenrouterAvailability()
  check('stale-with-models still reads READY (labelled, not hidden)', availability.state === 'ready' && availability.modelCount === 4)
}

{
  __resetOpenrouterCatalogueForTest()
  const unauthorized: typeof fetch = (async () =>
    new Response('{}', { status: 401 })) as unknown as typeof fetch
  await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: unauthorized })
  const availability = getOpenrouterAvailability()
  check('401 ⇒ disabled/auth-invalid (never "connecting")', availability.state === 'disabled' && availability.why === 'auth-invalid')
}

{
  __resetOpenrouterCatalogueForTest()
  const counter = { calls: [] as string[] }
  await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: pagedFetch(counter) })
  check('the REAL routing law recognizes the qualified slugs (the fold landed)', openrouterDispatchReady() === true)
  check('an injected recognizing law flips readiness', openrouterDispatchReady(() => 'openrouter') === true)
  const rows = getOpenrouterModelOptions()
  const modelRows = rows.filter(r => !String(r.value).startsWith('__'))
  check('ready picker renders the live rows in vendor order, values QUALIFIED', modelRows.length === 4 && modelRows[0]!.value === 'openrouter/anthropic/claude-fixture')
  const bracketRow = modelRows.find(r => String(r.value).includes('[1m]'))
  check(
    'a junk-shaped catalogue row renders visible-but-UNAVAILABLE (data kept, selection refused)',
    bracketRow?.value === 'openrouter/anthropic/claude-opus-5[1m]' &&
      bracketRow.unavailable !== undefined &&
      /display/.test(bracketRow.unavailable),
  )
  check(
    'clean rows stay selectable beside the junk row',
    modelRows.filter(r => r.unavailable === undefined).length === 3,
  )
  check('every row value carries the openrouter/ namespace; the copy is empty (the neutral grammar)', modelRows.every(r => String(r.value).startsWith('openrouter/') && r.description === ''), JSON.stringify(modelRows.map(r => [r.value, r.description])))
  check('routed rows carry no dispatch-pending refusal', modelRows.every(r => r.unavailable === undefined || !r.unavailable.includes('dispatch wire pending')))
  check('rows land in the OpenRouter picker group', modelRows.every(r => r.group === 'Mercury — OpenRouter models'))
  const stated = modelRows.find(r => r.value === 'openrouter/anthropic/claude-fixture')
  check('a row with a stated context_length carries statedContextWindow (200000)', stated?.statedContextWindow === 200000)
  const unstated = modelRows.find(r => r.value === 'openrouter/google/gemini-fixture')
  check('a row with NO stated context carries no window (no borrowed default)', unstated !== undefined && unstated.statedContextWindow === undefined)
  const { resolveContextWindow } = await import('../../src/utils/model/capabilities.js')
  const budget = resolveContextWindow('openrouter/anthropic/claude-fixture')
  check('resolveContextWindow budgets a listed openrouter id at its stated window', budget.effectiveWindow === 200000 && budget.source === 'live-current', JSON.stringify({ w: budget.effectiveWindow, s: budget.source }))
  const dressed = resolveContextWindow('openrouter/anthropic/claude-fixture[1m]')
  check('a Mercury-dressed openrouter id budgets as its listed base row (no lying 1M)', dressed.effectiveWindow === 200000, String(dressed.effectiveWindow))
  const unlisted = resolveContextWindow('openrouter/nobody/unlisted-model')
  check('an unlisted openrouter id falls to the LABELLED conservative default', unlisted.effectiveWindow === 200000 && unlisted.source === 'fallback' && /states no context length/.test(unlisted.fallbackReason ?? ''), JSON.stringify({ s: unlisted.source, r: unlisted.fallbackReason }))
  check('the reroute vendor filter answers mechanically', openrouterModelsForVendor('google').length === 1 && openrouterModelsForVendor('google')[0]!.id === 'google/gemini-fixture')
}

{
  __resetOpenrouterCatalogueForTest()
  const emptyFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ data: [], total_count: 0, links: { next: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: emptyFetch })
  const availability = getOpenrouterAvailability()
  check('connected-but-empty catalogue ⇒ disabled/no-models (never bare ready)', availability.state === 'disabled' && availability.why === 'no-models')
  const rows = getOpenrouterModelOptions()
  check('empty catalogue picker = ONE honest action row', rows.length === 1 && rows[0]!.label === 'OpenRouter — no models listed')
}
{
  __resetOpenrouterCatalogueForTest()
  const cursorFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: 'anthropic/claude-fixture' }],
        has_more: true,
        first_id: 'anthropic/claude-fixture',
        last_id: 'anthropic/claude-fixture',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  const snapshot = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: cursorFetch })
  check('has_more without links.next keeps the rows + LABELS the truncation', snapshot?.models.length === 1 && /has_more without links\.next/.test(snapshot?.lastError ?? ''))
  const availability = getOpenrouterAvailability()
  check('labelled-incomplete with rows still reads READY (stale-but-labelled)', availability.state === 'ready' && availability.modelCount === 1)
}
{
  __resetOpenrouterCatalogueForTest()
  const counter = { calls: [] as string[] }
  const endlessFetch: typeof fetch = (async (url: RequestInfo | URL) => {
    counter.calls.push(String(url))
    return new Response(JSON.stringify(PAGE_ONE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const snapshot = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: endlessFetch })
  check('endless next walk stops at the 5-page bound', counter.calls.length === 5)
  check('the bound stop labels the snapshot incomplete', /page bound with pages remaining/.test(snapshot?.lastError ?? ''))
}

{
  __resetOpenrouterUsageStateForTest()
  const keyFetch: typeof fetch = (async (url: RequestInfo | URL) => {
    check('key refresh hits the PINNED /key endpoint', String(url) === 'https://fixture.invalid/api/v1/key')
    return new Response(
      JSON.stringify({
        data: {
          label: 'Mercury',
          usage: 12.5,
          usage_daily: 0.5,
          usage_weekly: 3.25,
          usage_monthly: 9,
          limit: 100,
          limit_remaining: 87.5,
          limit_reset: 'monthly',
          is_free_tier: false,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  const usage = await refreshOpenrouterKeyUsage({ force: true, fetchImpl: keyFetch })
  check('key truth decoded (usage/caps/tier)', usage?.usage === 12.5 && usage?.limit === 100 && usage?.limitRemaining === 87.5 && usage?.isFreeTier === false && usage?.limitReset === 'monthly')
  const windows = providerUsage.openrouterObservedWindowViews()
  check('cap window view: (100-87.5)/100 = 12.5% used', windows.length === 1 && windows[0]!.key === 'cap' && Math.abs((windows[0]!.usedPct ?? 0) - 12.5) < 0.001)

  const view = providerUsage.activeSourceUsage({
    model: 'anything',
    reads: {
      route: () => 'openrouter',
      openrouterKeyPresent: () => true,
      openrouterObserved: () => openrouterObservedKeyUsage(),
      openrouterLimited: () => openrouterLimitWindow(),
      spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
    },
  })
  check('facade arm: api-spend shape + the cap window ride through', view.provider === 'openrouter' && view.shape === 'api-spend' && view.windows.length === 1)

  const now = 1_756_000_000_000
  recordOpenrouterRateHeaders(new Headers({ 'retry-after': '120' }), () => now)
  const window = openrouterLimitWindow(() => now)
  check('Retry-After folds into a limited window (+120s)', window.state === 'limited' && window.resetsAtMs === now + 120_000)
  __resetOpenrouterUsageStateForTest()
  recordOpenrouterRateHeaders(new Headers({ 'x-ratelimit-reset': '42' }), () => now)
  check('an ambiguous small reset value records NOTHING (never fabricated)', openrouterLimitWindow(() => now).state === 'clear')

  __resetOpenrouterUsageStateForTest()
  const uncapped: typeof fetch = (async () =>
    new Response(JSON.stringify({ data: { usage: 5, limit: null, limit_remaining: null } }), {
      status: 200,
    })) as unknown as typeof fetch
  const free = await refreshOpenrouterKeyUsage({ force: true, fetchImpl: uncapped })
  check('stated-null cap decodes as null (unlimited), no meter', free?.limit === null && providerUsage.openrouterObservedWindowViews().length === 0)
}

{
  __resetOpenrouterCatalogueForTest()
  const SINGLE_PAGE = { data: [{ id: 'anthropic/claude-fixture' }], links: { next: null } }
  const uas: string[] = []
  const uaFetch: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    uas.push(((init?.headers ?? {}) as Record<string, string>)['user-agent'] ?? '')
    return new Response(JSON.stringify(SINGLE_PAGE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: uaFetch })
  check('catalogue fetch presents mercury/<version>', uas.length === 1 && uas[0]!.startsWith('mercury/'))
  check('catalogue fetch never wears the claude-cli spelling', uas.every(u => !u.includes('claude-cli')))

  __resetOpenrouterUsageStateForTest()
  const keyUas: string[] = []
  const keyUaFetch: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    keyUas.push(((init?.headers ?? {}) as Record<string, string>)['user-agent'] ?? '')
    return new Response(JSON.stringify({ data: { usage: 1 } }), { status: 200 })
  }) as unknown as typeof fetch
  await refreshOpenrouterKeyUsage({ force: true, fetchImpl: keyUaFetch })
  check('key-usage fetch presents mercury/<version>', keyUas.length === 1 && keyUas[0]!.startsWith('mercury/') && !keyUas[0]!.includes('claude-cli'))
}

{
  __resetOpenrouterCatalogueForTest()
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-FIRSTKEY0000000000000'
  const c1 = { calls: [] as string[] }
  await refreshOpenrouterCatalogue('env', { fetchImpl: pagedFetch(c1) })
  check('first credential fetches its catalogue', c1.calls.length === 2)
  const c2 = { calls: [] as string[] }
  await refreshOpenrouterCatalogue('env', { fetchImpl: pagedFetch(c2) })
  check('same credential rides the TTL cache', c2.calls.length === 0)
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-RELOGINKEY00000000000'
  check('the relogin credential sees NO cached snapshot', getCachedOpenrouterCatalogue('env') === null)
  const c3 = { calls: [] as string[] }
  const fresh = await refreshOpenrouterCatalogue('env', { fetchImpl: pagedFetch(c3) })
  check('the relogin credential fetches FRESH (no snapshot reuse)', c3.calls.length === 2 && fresh?.models.length === 4)
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-PROVERKEY000000000000'
}

{
  __resetOpenrouterCatalogueForTest()
  const COMPAT_VIEW = {
    data: [
      { id: 'anthropic/claude-opus-5[1m]', type: 'model', display_name: 'Claude Opus 5', created_at: '2026-07-24T17:02:24.129Z', max_input_tokens: 1000000 },
      { id: 'anthropic/openai/gpt-5.6-sol[1m]', type: 'model', display_name: 'OpenAI: GPT-5.6 Sol', created_at: '2026-07-09T09:54:10.415Z' },
      { id: 'anthropic/x-ai/grok-4.6', type: 'model', display_name: 'xAI: Grok 4.6', created_at: '2026-07-01T00:00:00.000Z' },
    ],
  }
  const compatFetch: typeof fetch = (async () =>
    new Response(JSON.stringify(COMPAT_VIEW), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const snapshot = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: compatFetch })
  check('a whole-feed non-catalogue answer lands ZERO rows', snapshot?.models.length === 0)
  check('the refusal names the non-catalogue view', /non-catalogue view \(0\/3/.test(snapshot?.lastError ?? ''))
  const availability = getOpenrouterAvailability()
  check('availability reads catalogue-error (honest absence, never junk rows)', availability.state === 'disabled' && availability.why === 'catalogue-error')
  const rows = getOpenrouterModelOptions()
  check('picker paints ONE honest action row instead of unavailable junk', rows.length === 1 && rows[0]!.label === 'OpenRouter — catalogue unreachable')

  __resetOpenrouterCatalogueForTest()
  await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: pagedFetch({ calls: [] as string[] }) })
  const again = await refreshOpenrouterCatalogue('env', { force: true, fetchImpl: compatFetch })
  check('a later compat answer keeps the REAL rows stale-but-labelled', again?.models.length === 4 && /non-catalogue view/.test(again?.lastError ?? ''))
  const staleRows = getOpenrouterModelOptions()
  const staleRow = staleRows.find(r => r.label.includes('catalogue stale'))
  check('the picker surfaces the staleness with the failure reason', staleRow !== undefined && /non-catalogue view/.test(staleRow.description))
  check('the stale label rides the retry action row', staleRow?.value === '__mercury_openrouter_connect__')
}

delete process.env.OPENROUTER_API_KEY
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} openrouter-catalogue proof(s) failed`)
  process.exit(1)
}
console.log('✅ OPENROUTER CATALOGUE + USAGE TRUTH PROVEN (fixture rig)')
