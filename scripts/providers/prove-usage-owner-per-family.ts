#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-owner-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://fixture.invalid/deepseek'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://fixture.invalid/moonshot/v1'
process.env.MERCURY_MOONSHOT_CODING_BASE = 'http://127.0.0.1:9/coding/v1'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_ZAI_API_BASE = 'https://fixture.invalid/zai'
const CREDENTIAL_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'XAI_MANAGEMENT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HF_TOKEN', 'HUGGINGFACE_TOKEN'] as const
const signOut = (): void => {
  for (const name of CREDENTIAL_ENVS) delete process.env[name]
}
signOut()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const owner = await import('../../src/services/providers/providerUsage.ts')
const deepseekState = await import('../../src/services/providers/deepseek/deepseekUsageState.ts')
const moonshotState = await import('../../src/services/providers/moonshot/moonshotUsageState.ts')
const openrouterState = await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
const huggingfaceState = await import('../../src/services/providers/huggingface/huggingfaceUsageState.ts')
const geminiState = await import('../../src/services/providers/gemini/geminiUsageState.ts')
import type { RouterProviderId } from '../../src/utils/router/providers/types.js'

const FAMILIES: RouterProviderId[] = ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'xai', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local']
const xaiAuth = await import('../../src/services/providers/xai/xaiOauth.ts')
xaiAuth.writeXaiTokens({ accessToken: 'fixture-grok', refreshToken: 'fixture-refresh', expiresAtMs: Date.now() + 3600_000 })
xaiAuth.writePreferredXaiSource('grok-subscription')
let grokReads = 0
const grokUrls: string[] = []
await owner.refreshProviderUsage('xai', { fetchImpl: (async (url: string | URL | Request) => { grokReads++; grokUrls.push(String(url)); throw new Error('fixture: the pool endpoint is unreachable') }) as typeof fetch })
const grokUsage = owner.usageForProvider('xai')
check('Grok subscription asks only the proxy pool endpoint and, unreachable, names the failed read without fabricating a window or a balance', grokReads === 1 && grokUrls[0]?.endsWith('/billing?format=credits') === true && !grokUrls[0].includes('api.x.ai') && grokUsage.sourceKind === 'subscription-oauth' && grokUsage.windows.length === 0 && grokUsage.pools.length === 0 && grokUsage.credits?.state === 'unreported' && grokUsage.readerNote?.includes('Grok subscription pool read unavailable') === true && grokUsage.tier === 'Grok subscription')
xaiAuth.clearStoredXaiSubscription()

const WHOAMI = JSON.parse(readFileSync(join(ROOT, 'scripts/provider-compat/fixtures/huggingface-whoami-v2-documented.json'), 'utf8')) as { user: Record<string, unknown>; freeUser: Record<string, unknown> }
const GEMINI_ROADS = JSON.parse(readFileSync(join(ROOT, 'scripts/provider-compat/fixtures/gemini-usage-roads-2026-09-30.json'), 'utf8')) as { roads: Record<string, { status: number; quotaHeaders?: string[]; body?: { error?: { details?: { reason?: string }[] } } }> }
const NOW = 1_760_000_000_000
const now = (): number => NOW
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
let fetchCalls = 0
const fixtureFetch = (answer: (url: string) => Response | Promise<Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    fetchCalls += 1
    return answer(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
  }) as typeof fetch
const resetReaders = (): void => {
  deepseekState.__resetDeepseekUsageForTest()
  moonshotState.__resetMoonshotUsageForTest()
  openrouterState.__resetOpenrouterUsageStateForTest()
  huggingfaceState.__resetHuggingfaceUsageStateForTest()
  geminiState.__resetGeminiUsageStateForTest()
}

console.log('one usage owner per provider family — live where published, absent where not, sampled through one door')

section('§1 the readers land in the owner through the one refresh door, stamped')
{
  resetReaders()
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture-A'
  fetchCalls = 0
  await owner.refreshProviderUsage('deepseek', {
    fetchImpl: fixtureFetch(() => json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] })),
    env: process.env,
    now,
    force: true,
  })
  const ds = owner.usageForProvider('deepseek')
  check('deepseek: the door asked the balance endpoint once', fetchCalls === 1, String(fetchCalls))
  check('deepseek: the owner carries the provider-stated balance verbatim, stamped', ds.sourceKind === 'api-key' && ds.balance?.display === 'USD 12.34' && ds.balance?.observedAtMs === NOW, JSON.stringify(ds.balance))
  check('deepseek: a lane with a reader carries NO absence line', ds.absence === undefined && ds.readerNote === undefined)

  process.env.MOONSHOT_API_KEY = 'sk-moonshot-fixture'
  fetchCalls = 0
  await owner.refreshProviderUsage('moonshot', {
    fetchImpl: fixtureFetch(() => json({ code: 0, data: { available_balance: 5.5, voucher_balance: 0.5, cash_balance: 5 }, scode: '0x0', status: true })),
    env: process.env,
    now,
    force: true,
  })
  const ms = owner.usageForProvider('moonshot')
  check('moonshot key: the door asked the balance endpoint once', fetchCalls === 1, String(fetchCalls))
  check('moonshot key: the owner carries the USD balance, stamped', ms.sourceKind === 'api-key' && ms.balance?.display === 'USD 5.5' && ms.balance?.observedAtMs === NOW, JSON.stringify(ms.balance))

  const moonshotAccounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
  delete process.env.MOONSHOT_API_KEY
  moonshotAccounts.writeMoonshotTokens({ accessToken: 'kimi-fixture', refreshToken: 'kimi-refresh-fixture' }, 'global')
  fetchCalls = 0
  await owner.refreshProviderUsage('moonshot', {
    fetchImpl: fixtureFetch(url => {
      check('Kimi OAuth uses the coding usage endpoint, not the platform balance', url.endsWith('/coding/v1/usages'), url)
      return json({ usages: { limit_5h: { used_ratio: 0.25 } }, boosterWallet: { balance: { type: 'BOOSTER', amount: '2000000000', amountLeft: '1234000000' }, monthlyChargeLimit: { currency: 'USD', priceInCents: '5000' } } })
    }), env: process.env, now, force: true,
  })
  const kimi = owner.usageForProvider('moonshot')
  check('Kimi OAuth credits and windows share the one managed read', fetchCalls === 1 && kimi.sourceKind === 'oauth' && kimi.credits?.display === 'USD 12.34 Extra Usage balance' && kimi.credits.observedAtMs === NOW && kimi.windows[0]?.observedAtMs === NOW && kimi.windows[0]?.usedPct === 25, JSON.stringify(kimi))
  moonshotAccounts.writeMoonshotTokens(null)
  process.env.MOONSHOT_API_KEY = 'sk-moonshot-fixture'

  process.env.OPENROUTER_API_KEY = 'sk-or-fixture000'
  fetchCalls = 0
  await owner.refreshProviderUsage('openrouter', {
    fetchImpl: fixtureFetch(() => json({ data: { label: 'mercury', usage: 12.5, usage_weekly: 1.25, limit: 20, limit_remaining: 7.5, is_free_tier: false } })),
    env: process.env,
    now,
    force: true,
  })
  const or = owner.usageForProvider('openrouter')
  check('openrouter: the door asked the key endpoint once', fetchCalls === 1, String(fetchCalls))
  const orKeys = (or.figures ?? []).map(f => f.key).join(',')
  check('openrouter: the credit figures ride the owner in the provider\'s own units', orKeys === 'credits-all-time,credits-week,cap-remaining', orKeys)
  check('openrouter: each figure is the stated number to two decimals, stamped', or.figures?.[0]?.value === '12.50' && or.figures?.[1]?.value === '1.25' && or.figures?.[2]?.value === '7.50' && or.figures?.every(f => f.observedAtMs === NOW) === true, JSON.stringify(or.figures))
  check('openrouter: the per-key cap is the one percent window (62.5% of 20 used)', or.windows.length === 1 && or.windows[0]?.key === 'cap' && or.windows[0]?.state === 'live' && Math.abs((or.windows[0]?.usedPct ?? 0) - 62.5) < 1e-9, JSON.stringify(or.windows))
  check('openrouter: no absence line, no reader note while the reader answered', or.absence === undefined && or.readerNote === undefined)

  process.env.HF_TOKEN = 'hf_fixture000'
  huggingfaceState.recordHuggingfaceRateHeaders(new Headers({ ratelimit: '"default";r=950;t=3600' }), 200, now)
  const asked: string[] = []
  fetchCalls = 0
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(url => { asked.push(url); return json(WHOAMI.user) }), env: process.env, now, force: true })
  const hf = owner.usageForProvider('huggingface')
  check('huggingface: the door asks whoami-v2 once (the one road the Hub states account facts on)', fetchCalls === 1 && asked[0]?.endsWith('/api/whoami-v2') === true, `${fetchCalls} ${asked.join(',')}`)
  check('huggingface: the stated rate rides as a figure, with its reset', hf.figures?.some(f => f.key === 'rate-remaining' && f.value === '950' && f.resetsAtMs === NOW + 3_600_000) === true, JSON.stringify(hf.figures))
  const plan = hf.figures?.find(f => f.key === 'plan')
  check("huggingface: the plan the Hub stated rides as a figure — 'PRO' · 'plan · payment method on file' — endpoint-fed, stamped, with the period end from periodEnd (unix seconds)", plan?.value === 'PRO' && plan.label === 'plan · payment method on file' && plan.source === 'endpoint' && plan.observedAtMs === NOW && plan.resetsAtMs === (WHOAMI.user.periodEnd as number) * 1000, JSON.stringify(plan))
  check('huggingface: a token is API billing (the tier law), the credits line keeps the one spelling (the Hub states no balance), no reader note', hf.tier === 'API billing' && owner.usageCreditsLine(hf.credits, NOW) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && hf.readerNote === undefined, JSON.stringify({ tier: hf.tier, credits: hf.credits, note: hf.readerNote }))
  check('huggingface: the absence line names what whoami-v2 states, what it does not, and the billing page', typeof hf.absence === 'string' && hf.absence.includes('no spend or credit API') && hf.absence.includes('whoami-v2') && hf.absence.includes('not the credits used') && hf.absence.includes('huggingface.co/settings/billing'), hf.absence)
  fetchCalls = 0
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => json(WHOAMI.user)), env: process.env, now })
  check('huggingface: a re-show inside the freshness floor serves the last observation (no second ask)', fetchCalls === 0, String(fetchCalls))
  const facts = { observedAtMs: NOW, accountType: 'user' }
  const oauthReads = (over: Record<string, unknown> | null) => ({
    huggingfaceAccount: () => ({ kind: 'oauth', label: 'Hugging Face account (fixture)', keySource: 'oauth' }) as never,
    huggingfaceLimited: () => ({ state: 'clear' as const }),
    huggingfaceRate: () => null,
    huggingfaceAccountFacts: () => (over === null ? null : { ...facts, ...over }),
    huggingfaceAccountFactsFailure: () => null,
    spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  })
  const pro = owner.usageForProvider('huggingface', oauthReads({ isPro: true, canPay: true, periodEndMs: NOW + 86_400_000 }))
  const free = owner.usageForProvider('huggingface', oauthReads({ isPro: false, canPay: false }))
  const unread = owner.usageForProvider('huggingface', oauthReads(null))
  check("huggingface sign-in: the tier is the plan the Hub stated — 'Hugging Face PRO' · 'Hugging Face free' — and 'Hugging Face sign-in' until it is read", pro.tier === 'Hugging Face PRO' && free.tier === 'Hugging Face free' && unread.tier === 'Hugging Face sign-in', `${pro.tier} | ${free.tier} | ${unread.tier}`)
  check("huggingface sign-in: a free account's figure is 'free' · 'plan · no payment method', with no period end; nothing read is no figure", free.figures?.[0]?.value === 'free' && free.figures[0].label === 'plan · no payment method' && free.figures[0].resetsAtMs === undefined && unread.figures === undefined, JSON.stringify({ free: free.figures, unread: unread.figures }))
  check('huggingface sign-in: the sign-in carries the credits line too (the one spelling)', owner.usageCreditsLine(pro.credits, NOW) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && owner.usageCreditsLine(unread.credits, NOW, 'compact') === 'credits not reported')
  const { xaiUsageFixture, XAI_FIXTURE_NOW } = await import('./lib/xai-usage-fixture.ts')
  const xaiFixture = xaiUsageFixture()
  Object.assign(process.env, xaiFixture.env)
  try {
    await owner.refreshProviderUsage('xai', { env: process.env, now: () => XAI_FIXTURE_NOW, force: true })
    const xai = owner.usageForProvider('xai')
    check('xai: the owner reads team credits and billing-cycle usage through the management door', xai.credits?.display === 'USD 12.34 prepaid' && xai.figures?.[0]?.value === 'USD 21.00' && xaiFixture.requests.length === 5)
    check('xai: figures are endpoint-fed and stamped, with no false inference-key absence', xai.figures?.every(f => f.source === 'endpoint' && f.observedAtMs === XAI_FIXTURE_NOW) === true && !xai.absence)
    delete process.env.XAI_MANAGEMENT_API_KEY
    const noManagement = owner.usageForProvider('xai')
    const calls = xaiFixture.requests.length
    await owner.refreshProviderUsage('xai')
    check('xai: a management key is optional, absence names its login road and never errors or calls out', noManagement.absence === "add a management key from the console's settings page to read usage — /logins xai" && !noManagement.readerNote && noManagement.figures === undefined && calls === xaiFixture.requests.length)
  } finally { xaiFixture.stop(); delete process.env.XAI_API_KEY; delete process.env.XAI_MANAGEMENT_API_KEY }
}

section('§2 honest absence — the owner says the provider publishes nothing, and asks nothing')
{
  process.env.ZAI_API_KEY = 'zai-fixture000'
  process.env.GEMINI_API_KEY = 'AIza-fixture000'
  process.env.MERCURY_COMPAT_BASE_URL = 'https://fixture.invalid/compat/v1'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture000'
  process.env.OPENAI_API_KEY = 'sk-fixture000'
  for (const family of ['zai', 'gemini', 'openai-compat', 'anthropic', 'openai'] as const) {
    fetchCalls = 0
    await owner.refreshProviderUsage(family, { fetchImpl: fixtureFetch(() => json({})), env: process.env, now, force: true })
    check(`${family}: the refresh door makes NO request`, fetchCalls === 0, String(fetchCalls))
  }
  const zai = owner.usageForProvider('zai')
  check('zai (an env key is a general key): connected, api-spend, and the owner states that a general key has no usage road, naming the billing console', zai.sourceKind === 'api-key' && zai.shape === 'api-spend' && zai.absence === 'No usage road for a general Z.AI key — https://z.ai/manage-apikey/billing is the view', zai.absence)
  const gm = owner.usageForProvider('gemini')
  check('gemini: the owner carries the verified no-usage-endpoint line (the same constant the reader states)', gm.sourceKind === 'api-key' && gm.absence === geminiState.GEMINI_USAGE_ABSENCE_NOTE, gm.absence)
  check('gemini: the absence line says what Google states to the credential (nothing: no usage endpoint, no quota headers) and names the view', (gm.absence ?? '').includes('no usage endpoint') && (gm.absence ?? '').includes('no quota headers') && (gm.absence ?? '').includes('Quotas page') && (gm.absence ?? '').includes('AI Studio'), gm.absence)
  const roads = GEMINI_ROADS.roads
  const closed = ['code-assist-loadCodeAssist', 'code-assist-retrieveUserQuota', 'cloud-quotas-quotaInfos', 'cloud-monitoring-quota-usage']
  check('gemini: the recorded roads agree — the Gemini API reply carries no quota header, and every quota road answers 403 to a sign-in on the operator\'s own OAuth client', roads['gemini-api-reply-headers']?.status === 200 && roads['gemini-api-reply-headers']?.quotaHeaders?.length === 0 && closed.every(road => roads[road]?.status === 403), JSON.stringify(Object.fromEntries(Object.entries(roads).map(([k, v]) => [k, v.status]))))
  check('gemini: the Code Assist and Cloud Quotas refusals are SERVICE_DISABLED (not enabled on the client\'s project), so no figure is invented from them', ['code-assist-loadCodeAssist', 'code-assist-retrieveUserQuota', 'cloud-quotas-quotaInfos'].every(road => roads[road]?.body?.error?.details?.[0]?.reason === 'SERVICE_DISABLED'))
  const gmOauth = owner.usageForProvider('gemini', { geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }), geminiLimited: () => ({ state: 'clear' }), spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }) })
  check("gemini sign-in: the Google account carries the credits line (the one spelling), the 'Google sign-in' tier, the absence line, and no figure", gmOauth.sourceKind === 'oauth' && owner.usageCreditsLine(gmOauth.credits, NOW) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && owner.usageCreditsLine(gmOauth.credits, NOW, 'compact') === 'credits not reported' && gmOauth.tier === 'Google sign-in' && gmOauth.absence === geminiState.GEMINI_USAGE_ABSENCE_NOTE && gmOauth.figures === undefined, JSON.stringify({ credits: gmOauth.credits, tier: gmOauth.tier, figures: gmOauth.figures }))
  const compat = owner.usageForProvider('openai-compat')
  check('custom endpoint: the owner says the endpoint publishes nothing Mercury reads', compat.sourceKind === 'api-key' && typeof compat.absence === 'string' && compat.absence.includes('publishes no usage'), compat.absence)
  const anth = owner.usageForProvider('anthropic')
  check('an API key on the first-party lane: no windows, the absence names the console as the view', anth.sourceKind === 'api-key' && anth.windows.length === 0 && typeof anth.absence === 'string' && anth.absence.includes('no usage endpoint is read for an API key'), JSON.stringify({ kind: anth.sourceKind, absence: anth.absence }))
  const oa = owner.usageForProvider('openai')
  check('an API key on the OpenAI lane: the same absence line', oa.sourceKind === 'api-key' && oa.absence === anth.absence, JSON.stringify({ kind: oa.sourceKind, absence: oa.absence }))
  const local = owner.usageForProvider('local', { localAccount: () => ({ kind: 'keyless', label: 'Ollama (2)', serverCount: 1, modelCount: 2 }) as never, spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }) })
  check('a local server: connected, metered by nothing, the absence line says so', local.sourceKind === 'keyless' && local.absence === 'local · no metering')
  check('every absence line is a sentence that names a view or a reason (never a bare word)', [zai, gm, compat, anth].every(u => (u.absence ?? '').length > 40))
  check('a connected lane with an absence carries no figures and no windows (nothing is fabricated)', [zai, gm, compat, anth, oa].every(u => u.windows.length === 0 && u.figures === undefined))
}

section('§3 the reader speaks about itself: a failed poll, a provider-marked unavailable account')
{
  openrouterState.__resetOpenrouterUsageStateForTest()
  await owner.refreshProviderUsage('openrouter', {
    fetchImpl: fixtureFetch(() => {
      throw new Error('fixture: socket closed')
    }),
    env: process.env,
    now,
    force: true,
  })
  const or = owner.usageForProvider('openrouter')
  const { openrouterSlots } = await import('../../src/services/providers/accountSlots.js')
  check('openrouter: a failed poll names the failed API key slot and keeps the error under that slot, no figures', or.figures === undefined && or.readerNote === 'credit truth unavailable for API key (env)' && openrouterSlots().find(slot => slot.id === 'openrouter:env-key')?.stateNote === 'fixture: socket closed', JSON.stringify({ figures: or.figures, note: or.readerNote }))
  check('openrouter: …and no window is fabricated', or.windows.length === 0)

  deepseekState.__resetDeepseekUsageForTest()
  await owner.refreshProviderUsage('deepseek', {
    fetchImpl: fixtureFetch(() => json({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] })),
    env: process.env,
    now,
    force: true,
  })
  const ds = owner.usageForProvider('deepseek')
  check('deepseek: the provider\'s own unavailable word rides beside the balance', ds.balance?.display === 'CNY 0.00' && ds.readerNote === 'the provider marks this account unavailable for inference', JSON.stringify({ balance: ds.balance, note: ds.readerNote }))
  const io = { fetchImpl: fixtureFetch(() => { throw new Error('unreachable') }), env: process.env, now, force: true }
  let threw = false
  try {
    await owner.refreshProviderUsage('deepseek', io)
  } catch {
    threw = true
  }
  check('the refresh door never throws (the last observation stands)', !threw && owner.usageForProvider('deepseek').balance?.display === 'CNY 0.00')

  huggingfaceState.__resetHuggingfaceUsageStateForTest()
  process.env.HF_TOKEN = 'hf_fixture000'
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => new Response('{"error":"Invalid credentials in Authorization header"}', { status: 401, headers: { 'content-type': 'application/json' } })), env: process.env, now, force: true })
  const hfRefused = owner.usageForProvider('huggingface')
  check("huggingface: a refused whoami is the reader's own line — 'no plan read (the Hub refused the token · HTTP 401)' — the tier stays honest and no plan figure is invented", hfRefused.readerNote === 'no plan read (the Hub refused the token · HTTP 401)' && hfRefused.readerNoteCompact === hfRefused.readerNote && !(hfRefused.figures ?? []).some(f => f.key === 'plan') && hfRefused.tier === 'API billing', JSON.stringify({ note: hfRefused.readerNote, figures: hfRefused.figures }))
  fetchCalls = 0
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => json(WHOAMI.user)), env: process.env, now })
  check('huggingface: a failed read is not retried inside the floor (no hammering a refusing Hub)', fetchCalls === 0, String(fetchCalls))
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => { throw new Error('fixture: socket closed') }), env: process.env, now, force: true })
  check("huggingface: an unreachable Hub says so — 'no plan read (Hub unreachable · fixture: socket closed)'", owner.usageForProvider('huggingface').readerNote === 'no plan read (Hub unreachable · fixture: socket closed)', owner.usageForProvider('huggingface').readerNote)
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => json(WHOAMI.freeUser)), env: process.env, now: () => NOW + 1_000, force: true })
  const hfRecovered = owner.usageForProvider('huggingface')
  check('huggingface: the next answer clears the note and lands the stated plan (free, no payment method, no period end)', hfRecovered.readerNote === undefined && hfRecovered.figures?.find(f => f.key === 'plan')?.value === 'free' && hfRecovered.figures.find(f => f.key === 'plan')?.resetsAtMs === undefined, JSON.stringify({ note: hfRecovered.readerNote, figures: hfRecovered.figures }))
  const words = owner.usageSummaryWords(hfRecovered, NOW + 1_000)
  check("huggingface: the doctor's summary carries the tier, the absence, the credits line and the plan (never a fabricated balance)", words.startsWith('API billing · ') && words.includes(`credits: ${owner.CREDITS_UNREPORTED_WORDS}`) && words.includes('whoami-v2') && !/USD/.test(words), words)
}

section('§4 signed out: every family carries its why-not and no figure')
{
  signOut()
  resetReaders()
  const { __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
  __resetLocalDiscoveryForTest()
  for (const family of FAMILIES) {
    const u = owner.usageForProvider(family)
    check(`${family}: signed out ⇒ sourceKind none, a why-not, no windows, no figures, no absence`, u.sourceKind === 'none' && typeof u.whyNot === 'string' && u.whyNot.length > 0 && u.windows.length === 0 && u.figures === undefined && u.absence === undefined && u.readerNote === undefined, JSON.stringify(u))
    fetchCalls = 0
    await owner.refreshProviderUsage(family, { fetchImpl: fixtureFetch(() => json({})), env: process.env, now, force: true })
    check(`${family}: the refresh door asks nothing without a credential`, fetchCalls === 0, String(fetchCalls))
  }
}

section('§5 never remembered: a credential switch drops the departed key\'s record')
{
  resetReaders()
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture-A'
  await owner.refreshProviderUsage('deepseek', {
    fetchImpl: fixtureFetch(() => json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '99.00' }] })),
    env: process.env,
    now,
    force: true,
  })
  check('key A: its balance is observed', owner.usageForProvider('deepseek').balance?.display === 'USD 99.00')
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture-B'
  const afterSwitch = owner.usageForProvider('deepseek')
  check('key B: the owner reads NOTHING observed — key A\'s balance is not remembered for B', afterSwitch.sourceKind === 'api-key' && afterSwitch.balance === undefined, JSON.stringify(afterSwitch.balance))
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture000'
  await owner.refreshProviderUsage('openrouter', {
    fetchImpl: fixtureFetch(() => json({ data: { usage: 1, limit: 10, limit_remaining: 9 } })),
    env: process.env,
    now,
    force: true,
  })
  check('openrouter key 1: figures observed', (owner.usageForProvider('openrouter').figures?.length ?? 0) > 0)
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture111'
  check('openrouter key 2: nothing observed, no cap window (the departed key\'s credits never repaint)', owner.usageForProvider('openrouter').figures === undefined && owner.usageForProvider('openrouter').windows.length === 0)
  process.env.HF_TOKEN = 'hf_fixture_token_A'
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => json(WHOAMI.user)), env: process.env, now, force: true })
  check('huggingface token A: its plan is observed', owner.usageForProvider('huggingface').figures?.some(f => f.key === 'plan' && f.value === 'PRO') === true)
  process.env.HF_TOKEN = 'hf_fixture_token_B'
  const hfB = owner.usageForProvider('huggingface')
  check("huggingface token B: nothing observed — token A's plan never repaints, the tier falls back", !(hfB.figures ?? []).some(f => f.key === 'plan') && hfB.readerNote === undefined, JSON.stringify(hfB.figures))
  signOut()
  resetReaders()
}

section('§6 the beside-rows walk every family: the OpenRouter cap joins, a windowless lane stays quiet')
{
  const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  const reads = {
    route: () => 'anthropic' as const,
    activeEntry: () => undefined,
    spend: () => spend,
    openrouterKeyPresent: () => true,
    openrouterObserved: () => ({ usage: { limit: 20, limitRemaining: 5, observedAtMs: NOW } }),
    openrouterLimited: () => ({ state: 'clear' as const }),
    moonshotAccount: () => undefined,
    zaiKeyPresent: () => true,
  }
  const r = owner.windowSourceUsages({ model: 'claude-sonnet-5', reads })
  check('the focused (signed-out) first-party source leads', r.primary.provider === 'anthropic' && r.primary.sourceKind === 'none')
  check('the OpenRouter cap window rides beside (75% of the key cap used)', r.others.length === 1 && r.others[0]?.provider === 'openrouter' && Math.abs((r.others[0]?.windows[0]?.usedPct ?? 0) - 75) < 1e-9, JSON.stringify(r.others.map(o => [o.provider, o.windows])))
  check('a connected but windowless lane (the Z.AI key) adds no row', r.others.every(o => o.provider !== 'zai'))
  const quiet = owner.windowSourceUsages({ model: 'claude-sonnet-5', reads: { ...reads, openrouterObserved: () => ({ usage: { limit: null, observedAtMs: NOW } }) } })
  check('an uncapped key states no percent ⇒ no beside-row', quiet.others.length === 0, JSON.stringify(quiet.others.map(o => o.provider)))
}

section('§7 the shape: the tab reads only the owner')
{
  const tab = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the tab imports no reader module (every *UsageState import is gone)', !/UsageState\.js'/.test(tab), (tab.match(/UsageState\.js'/g) ?? []).join(','))
  check('the tab never refreshes a reader directly (the discovery re-probe rides the door too)', !tab.includes('refreshLocalDiscovery') && !tab.includes('refreshOpenrouterKeyUsage') && !tab.includes('refreshDeepseekBalance') && !tab.includes('refreshMoonshotBalance') && !tab.includes('refreshKimiManagedUsage'))
  check('the tab samples through the one door and reads the one view', tab.includes("refreshProviderUsage(id, { reason: 'open' })") && tab.includes('return usageForProvider(id)'))
  for (const family of ['openrouter', 'moonshot', 'local', 'huggingface'] as const) {
    check(`the ${family} section rides useOwnerUsage`, tab.includes(`useOwnerUsage('${family}'`))
  }
  const geminiSection = tab.slice(tab.indexOf('function GeminiUsageSection'), tab.indexOf('function HuggingfaceUsageSection'))
  const hfSection = tab.slice(tab.indexOf('function HuggingfaceUsageSection'), tab.indexOf('function LocalUsageSection'))
  check('the Gemini section paints its credits line once, under its identity line through the one credits composer, never again under the Google account slot', tab.includes('<UsageCredits usage={usageForProvider(family)} />') && !geminiSection.includes('usageCreditsLine(usage.credits)'))
  check('the Hugging Face section paints its credits line once under its identity line, and the plan row rides the plan figure with the one stamp composer', !hfSection.includes('usageCreditsLine(usage.credits)') && hfSection.includes("f.key === 'plan'") && hfSection.includes('usageSourceWords(plan)') && hfSection.includes('period ends'))
  check('the generic engine body rides useOwnerUsage(section.id)', tab.includes('useOwnerUsage(section.id, section.family.credentialed)'))
  check('the credit line, the rate line and the credits lines come from the owner\'s figures and credits view', tab.includes('figuresLine(usage)') && tab.includes('usageCreditsLine(usage.credits)') && !tab.includes('usage.balance.display'))
  check('the absence lines come from the owner (never a tab-only constant)', tab.includes('usage.absence ?? section.limitsNote') && tab.includes("usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote") && !tab.includes('GEMINI_USAGE_ABSENCE_NOTE') && !tab.includes('HUGGINGFACE_USAGE_ABSENCE_NOTE'))
  const ownerSrc = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  check('the owner walks every declared family for the beside-rows (no hand-kept window-capable list)', ownerSrc.includes("['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)]") && !ownerSrc.includes('WINDOW_CAPABLE_PROVIDERS'))
  check('the beside-rows memo is registered as ttl-bounded', readFileSync(join(ROOT, 'scripts/staleness/prove-stale-registry.ts'), 'utf8').includes('providerUsage.ts :: otherUsagesCache :: ttl-bounded'))
}

section('§8 the first-party subscription: the extra-usage figure rides the one usage GET (a loopback fixture, never the live endpoint)')
{
  const { createServer } = await import('node:http')
  const { writeFileSync } = await import('node:fs')
  const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/anthropic-oauth-usage.json'), 'utf8')) as { body: Record<string, unknown> }
  let answer: Record<string, unknown> = fixture.body
  const usageRequests: string[] = []
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/oauth/usage')) {
      usageRequests.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.ANTHROPIC_BASE_URL = base
  writeFileSync(
    join(scratch, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-live', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }),
  )
  const { dropCredentialMemos } = await import('../../src/utils/auth.js')
  const { resetWalletEntriesMemo } = await import('../../src/services/wallet/wallet.js')
  const limits = await import('../../src/services/claudeAiLimits.ts')
  const reader = await import('../../src/services/providers/anthropic/anthropicUsageState.ts')
  dropCredentialMemos()
  resetWalletEntriesMemo()
  reader._resetAnthropicUsageReaderForTesting()
  limits.resetLimitsForCredentialSwitch()
  const before = owner.usageForProvider('anthropic')
  check('signed in, nothing read yet: the subscription view carries the credits line in its not-read arm', before.sourceKind === 'subscription-oauth' && before.credits?.state === 'unreported' && before.credits.reason === owner.EXTRA_USAGE_NOT_READ_WORDS, JSON.stringify(before.credits))
  await owner.refreshProviderUsage('anthropic', { reason: 'operator' })
  const off = owner.usageForProvider('anthropic')
  check('the door asked the usage endpoint exactly once', usageRequests.length === 1, JSON.stringify(usageRequests))
  check("the recorded answer (extra usage turned off by the user) lands as 'extra usage off', endpoint-fed, beside the pair", off.credits?.state === 'unreported' && owner.usageCreditsLine(off.credits) === 'credits: extra usage off' && off.credits.source === 'endpoint' && off.windows.map(w => `${w.key}=${w.usedPct}`).join(',') === '5h=20,7d=22', JSON.stringify({ credits: off.credits, windows: off.windows }))
  check('the reader carries no failure note and the read counted once', off.readerNote === undefined && reader.anthropicUsageReadStatus().requests === 1)
  answer = { ...fixture.body, extra_usage: { ...(fixture.body.extra_usage as object), is_enabled: true, user_disabled: false, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'USD', decimal_places: 2 } }
  await owner.refreshProviderUsage('anthropic', { reason: 'operator' })
  const on = owner.usageForProvider('anthropic')
  check('the operator\'s ask made one more request — the figure rides the same GET as the windows (no second poll)', usageRequests.length === 2, String(usageRequests.length))
  check("the enabled answer lands as the reported figure: 'extra usage USD 12.40 of 50.00 this month' · 'extra 12.40/50'", on.credits?.state === 'reported' && on.credits.display === 'extra usage USD 12.40 of 50.00 this month' && on.credits.compact === 'extra 12.40/50' && on.credits.source === 'endpoint' && typeof on.credits.observedAtMs === 'number', JSON.stringify(on.credits))
  check('the figure carries the same stamp as the windows it rode with', on.credits?.observedAtMs === on.windows[0]?.observedAtMs, JSON.stringify({ credits: on.credits?.observedAtMs, window: on.windows[0]?.observedAtMs }))
  check('the summary words carry it for the doctor', owner.usageSummaryWords(on).includes('credits: extra usage USD 12.40 of 50.00 this month'), owner.usageSummaryWords(on))
  limits.resetLimitsForCredentialSwitch()
  check('a credential switch drops the figure with the windows (never remembered for the next account)', owner.usageForProvider('anthropic').credits?.reason === owner.EXTRA_USAGE_NOT_READ_WORDS)
  server.close()
  delete process.env.ANTHROPIC_BASE_URL
  writeFileSync(join(scratch, '.credentials.json'), '{}')
  dropCredentialMemos()
  resetWalletEntriesMemo()
}

section('§9 the ChatGPT sign-in: the observed balance belongs to the same owner as its windows, and leaves with them')
{
  const openai = await import('../../src/services/providers/openai/openaiLimitState.ts')
  const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/openai-chatgpt-usage.json'), 'utf8'))
  openai.__resetOpenaiLimitStateForTest()
  openai.recordOpenaiUsageResponse(fixture.body, NOW)
  const view = owner.usageForProvider('openai', {
    activeEntry: () => ({ id: 'openai:subscription', provider: 'openai', kind: 'oauth', label: 'ChatGPT Pro', custodian: 'openai-accounts', identity: { plan: 'pro' } }),
    openaiObserved: openai.openaiObservedUsage,
    openaiLimited: () => ({ state: 'clear' }),
    spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  })
  check('OpenAI subscription: the observed fixture balance belongs to the same owner as its windows', view.shape === 'subscription-windows' && view.credits?.display === '62,500' && view.credits.source === 'endpoint' && view.credits.observedAtMs === NOW)
  openai.forgetOpenaiLimitSource('chatgpt-subscription')
  check('OpenAI subscription: forgetting the source drops the balance and bands together', Object.keys(openai.openaiObservedUsage()).length === 0)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-owner-per-family${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
