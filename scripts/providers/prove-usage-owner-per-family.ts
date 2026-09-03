#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-usage-owner-per-family.ts — ONE usage owner per
//  provider family behind ONE interface (the usage-neutrality law, row 2):
//  live-derived where the provider exposes usage, honest absence where it
//  does not, sampled through one refresh door, never remembered across a
//  credential switch.
//
//  Before this owner shape the Usage tab imported five reader modules and
//  composed OpenRouter's credit line, DeepSeek's and Moonshot's balance
//  lines and Hugging Face's rate line itself, and the owner carried no
//  absence for a connected Z.AI key, a Gemini account, a custom endpoint or
//  an API key on the two subscription lanes — the "publishes nothing" truth
//  lived in tab copy alone, and the rail's beside-rows walked a hand-kept
//  three-family list.
//
//   §1 the readers land in the owner: DeepSeek balance · Moonshot balance ·
//      OpenRouter credit figures + cap window · Hugging Face stated rate —
//      each through refreshProviderUsage with a fixture wire, stamped
//   §2 honest absence: Z.AI · Gemini · custom endpoint · an API key on the
//      first-party and OpenAI lanes · a local server — the owner says so and
//      the refresh door asks nothing
//   §3 the reader's own note: a failed poll with nothing observed is a
//      labelled line, a provider-marked unavailable account rides beside
//      its balance
//   §4 signed out: every family carries its why-not and NO figure
//   §5 never remembered: a credential switch drops the departed key's record
//   §6 the beside-rows derive over EVERY family (the OpenRouter cap joins)
//   §7 the shape: the tab reads only the owner
//
//  Run:  ~/.bun/bin/bun run scripts/providers/prove-usage-owner-per-family.ts
// ============================================================================
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
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_ZAI_API_BASE = 'https://fixture.invalid/zai'
const CREDENTIAL_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HF_TOKEN', 'HUGGINGFACE_TOKEN'] as const
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

const FAMILIES: RouterProviderId[] = ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local']
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

// ── §1 the readers land in the owner ────────────────────────────────────────
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
  fetchCalls = 0
  await owner.refreshProviderUsage('huggingface', { fetchImpl: fixtureFetch(() => json({})), env: process.env, now, force: true })
  const hf = owner.usageForProvider('huggingface')
  check('huggingface: the door asks nothing (no spend API is documented)', fetchCalls === 0, String(fetchCalls))
  check('huggingface: the stated rate rides as the one figure, with its reset', hf.figures?.length === 1 && hf.figures[0]?.key === 'rate-remaining' && hf.figures[0]?.value === '950' && hf.figures[0]?.resetsAtMs === NOW + 3_600_000, JSON.stringify(hf.figures))
  check('huggingface: the absence of a spend API still rides beside the figure', typeof hf.absence === 'string' && hf.absence.includes('no spend or credit API'))
}

// ── §2 honest absence ───────────────────────────────────────────────────────
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
  check('zai: connected, api-spend, and the owner states the verified absence (no usage or balance endpoint, dated)', zai.sourceKind === 'api-key' && zai.shape === 'api-spend' && typeof zai.absence === 'string' && zai.absence.includes('no usage or balance endpoint') && zai.absence.includes('2026-09-01'), zai.absence)
  const gm = owner.usageForProvider('gemini')
  check('gemini: the owner carries the verified no-usage-endpoint line (the same constant the reader states)', gm.sourceKind === 'api-key' && gm.absence === geminiState.GEMINI_USAGE_ABSENCE_NOTE, gm.absence)
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

// ── §3 the reader's own note ────────────────────────────────────────────────
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
  check('openrouter: a failed poll with nothing observed is the reader\'s labelled line, no figures', or.figures === undefined && or.readerNote === 'credit truth unavailable (fixture: socket closed)', JSON.stringify({ figures: or.figures, note: or.readerNote }))
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
}

// ── §4 signed out ───────────────────────────────────────────────────────────
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

// ── §5 never remembered ─────────────────────────────────────────────────────
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
  signOut()
  resetReaders()
}

// ── §6 the beside-rows derive over every family ─────────────────────────────
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

// ── §7 the shape ────────────────────────────────────────────────────────────
section('§7 the shape: the tab reads only the owner')
{
  const tab = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the tab imports no reader module (every *UsageState import is gone)', !/UsageState\.js'/.test(tab), (tab.match(/UsageState\.js'/g) ?? []).join(','))
  check('the tab never refreshes a reader directly (the discovery re-probe rides the door too)', !tab.includes('refreshLocalDiscovery') && !tab.includes('refreshOpenrouterKeyUsage') && !tab.includes('refreshDeepseekBalance') && !tab.includes('refreshMoonshotBalance') && !tab.includes('refreshKimiManagedUsage'))
  check('the tab samples through the one door and reads the one view', tab.includes('refreshProviderUsage(id)') && tab.includes('return usageForProvider(id)'))
  for (const family of ['openrouter', 'moonshot', 'local'] as const) {
    check(`the ${family} section rides useOwnerUsage`, tab.includes(`useOwnerUsage('${family}'`))
  }
  check('the generic engine body rides useOwnerUsage(section.id)', tab.includes('useOwnerUsage(section.id, section.family.credentialed)'))
  check('the credit line, the rate line and the credits lines come from the owner\'s figures and credits view', tab.includes('figuresLine(usage)') && tab.includes('usageCreditsLine(usage.credits)') && !tab.includes('usage.balance.display'))
  check('the absence lines come from the owner (never a tab-only constant)', tab.includes('usage.absence ?? section.limitsNote') && tab.includes("usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote") && !tab.includes('GEMINI_USAGE_ABSENCE_NOTE') && !tab.includes('HUGGINGFACE_USAGE_ABSENCE_NOTE'))
  const ownerSrc = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  check('the owner walks every declared family for the beside-rows (no hand-kept window-capable list)', ownerSrc.includes("['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)]") && !ownerSrc.includes('WINDOW_CAPABLE_PROVIDERS'))
  check('the beside-rows memo is registered as ttl-bounded', readFileSync(join(ROOT, 'scripts/staleness/prove-stale-registry.ts'), 'utf8').includes('providerUsage.ts :: otherUsagesCache :: ttl-bounded'))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-owner-per-family${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
