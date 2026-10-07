#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-meters-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HF_TOKEN', 'HUGGINGFACE_TOKEN', 'MERCURY_USAGE_SEED']) {
  delete process.env[name]
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const owner = await import('../../src/services/providers/providerUsage.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const limits = await import('../../src/services/anthropicLimits.ts')
const { providerLimitWarning } = await import('../../src/services/providers/limitWarning.ts')
type Reads = NonNullable<Parameters<typeof owner.activeSourceUsage>[0]>['reads']

const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const subEntry = { id: 'fx-sub', provider: 'anthropic', kind: 'oauth', label: 'fixture subscription', custodian: 'anthropic-slots' } as const

function subscriptionReads(over: { pools?: boolean; readAtMs?: number } = {}): Reads {
  const readAtMs = over.readAtMs ?? NOW - 10_000
  const stamp = { source: 'endpoint' as const, observedAtMs: readAtMs }
  return {
    route: () => 'anthropic',
    activeEntry: () => ({ ...subEntry }),
    anthropicPlan: () => 'max',
    spend: () => spend,
    anthropicWindows: () => ({
      fiveHour: { key: '5h', usedPct: 36, resetsAtMs: NOW + 2 * HOUR + 10 * MIN, state: 'live', ...stamp },
      sevenDay: { key: '7d', usedPct: 44, resetsAtMs: NOW + 6 * 24 * HOUR + 3 * HOUR, state: 'live', ...stamp },
    }),
    anthropicPoolWindows: () =>
      over.pools === false
        ? []
        : [
            { key: 'seven_day_fable', label: 'Fable', state: 'live', usedPct: 87, resetsAtMs: NOW + 22 * HOUR + 51 * MIN, ...stamp, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS },
            { key: 'seven_day_opus', label: 'Opus', state: 'live', usedPct: 61, resetsAtMs: NOW + 5 * 24 * HOUR, ...stamp, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS },
            { key: 'seven_day_sonnet', label: 'Sonnet', state: 'live', usedPct: 20, resetsAtMs: NOW + 5 * 24 * HOUR, ...stamp, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS },
          ],
  } as Reads
}

console.log('every usage meter tells the truth — pools visible, the binding window, feed + age, credits, never a fabricated zero')

section('§1 the per-model pools ride the active-source view, and every renderer folds them into the family block')
{
  const view = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads() })
  check('the shared pair stays the shared pair (5h · 7d)', view.windows.map(w => w.key).join(',') === '5h,7d', view.windows.map(w => w.key).join(','))
  check('the three pools ride the view, labelled by their family', view.pools.map(p => `${p.label}=${p.usedPct}`).join(',') === 'Fable=87,Opus=61,Sonnet=20', JSON.stringify(view.pools))
  check('a pool is keyed by the wire claim (the warning owner names it in the wire vocabulary)', view.pools.map(p => p.key).join(',') === 'seven_day_fable,seven_day_opus,seven_day_sonnet')
  const withoutPools = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads({ pools: false }) })
  check('a subscription that reports no pools carries none (empty, never fabricated)', withoutPools.pools.length === 0 && withoutPools.windows.length === 2)
  for (const family of ['openai', 'openrouter', 'zai', 'deepseek', 'moonshot', 'gemini', 'huggingface', 'openai-compat', 'local'] as const) {
    const u = owner.usageForProvider(family, { spend: () => spend })
    check(`${family}: a family that reports no per-model pools shows none`, Array.isArray(u.pools) && u.pools.length === 0)
  }

  const rail = src('src/utils/cockpit/helmTelemetryModel.ts')
  check('the rail folds the focused source\'s pools under its windows', rail.includes('...source.pools.filter(w => w.state === \'live\').map(w => ({ w, pool: true }))') && rail.includes("meterRowsOf(usage, 'usage:', "))
  check('…and every beside-account\'s pools under its own block', rail.includes('meterRowsOf(other, `usage:${other.provider}:`, '))
  check('the rail\'s meter tail carries the read\'s age and turns stale before the countdown', rail.includes('usageAgeTail(w, readNow)') && rail.includes('usageViewIsStale(w, readNow)') && rail.includes('meterTail(w, pool)'))
  const band = src('src/components/MercuryFrame.tsx')
  check('the frame band\'s second chip is the binding window', band.includes('usage.binding.window.key !== first.key') && band.includes('? usage.binding.window'))
  const strip = src('src/components/DeckPane.tsx')
  check('the deck strip\'s second chip is the binding window', strip.includes('sourceUsage.binding.window.key !== stripFirst.key'))
  const tab = src('src/components/Settings/Usage.tsx')
  check('the tab reads the pools through the owner\'s pool view, titled by label', tab.includes('anthropicPoolWindowViews()') && tab.includes('`Current week (${w.label})`'))
  check('the tab decodes the fetch response nowhere (one owner, one decode)', !tab.includes('data.seven_day_') && !tab.includes('data.five_hour'))
  const health = src('src/utils/healthReport.ts')
  check('/health mounts one usage row per signed-in family from the owner', health.includes('id: `usage-${presence.id}`') && health.includes('owner.usageSummaryWords(owner.usageForProvider(presence.id))'))
  check('…in the AUTH section after the credential rows', health.includes('...providerAuthChecks(), ...providerUsageChecks()'))
}

section('§2 the binding window is the model\'s own: its family\'s pool, the shared pair, never another family\'s week')
{
  const cases: Array<[string, string, string]> = [
    ['claude-fable-5-1', 'seven_day_fable', 'Fable limit'],
    ['claude-fable-5-1[1m]', 'seven_day_fable', 'Fable limit'],
    ['claude-mythos-5-1', 'seven_day_fable', 'Fable limit'],
    ['claude-opus-5', 'seven_day_opus', 'Opus limit'],
    ['claude-sonnet-5', '7d', 'weekly limit'],
    ['claude-haiku-4-5-20251001', '7d', 'weekly limit'],
  ]
  for (const [model, key, name] of cases) {
    const view = owner.activeSourceUsage({ model, reads: subscriptionReads() })
    check(`${model}: binds on ${key} (${name})`, view.binding?.window.key === key && view.binding?.windowName === name, JSON.stringify(view.binding))
    const accessor = owner.bindingWindowFor(model, subscriptionReads())
    check(`${model}: the cap offer's accessor answers the same window`, accessor?.window.key === key && accessor?.windowName === name)
  }
  check('the pool claim for a model is the owner\'s one rule (fable/mythos · opus · sonnet · none)', limits.weeklyPoolClaimForModel('claude-fable-5-1') === 'seven_day_fable' && limits.weeklyPoolClaimForModel('claude-mythos-5-1') === 'seven_day_fable' && limits.weeklyPoolClaimForModel('claude-opus-5') === 'seven_day_opus' && limits.weeklyPoolClaimForModel('claude-sonnet-5') === 'seven_day_sonnet' && limits.weeklyPoolClaimForModel('claude-haiku-4-5') === undefined)
  const fable = providerLimitWarning({ model: 'claude-fable-5-1', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Fable session is warned about the Fable week (87%)', /^Anthropic: 87% of the Fable limit used · resets /.test(fable?.text ?? ''), fable?.text ?? '(null)')
  const sonnet = providerLimitWarning({ model: 'claude-sonnet-5', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Sonnet session is NOT warned about the Fable week (its own windows sit at 44 and 20)', sonnet === null, JSON.stringify(sonnet))
  const haiku = providerLimitWarning({ model: 'claude-haiku-4-5-20251001', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Haiku session is capped by the shared pair alone (no warning at 44)', haiku === null)
  const pairBinds = owner.activeSourceUsage({
    model: 'claude-fable-5-1',
    reads: { ...subscriptionReads(), anthropicWindows: () => ({ fiveHour: { key: '5h', usedPct: 91, resetsAtMs: NOW + HOUR, state: 'live' }, sevenDay: { key: '7d', usedPct: 44, resetsAtMs: NOW + HOUR, state: 'live' } }) } as Reads,
  })
  check('when the session window binds harder than the pool, the session window is the binding one', pairBinds.binding?.window.key === '5h' && pairBinds.binding?.windowName === 'session limit')
  const gpt = owner.activeSourceUsage({
    model: 'gpt-5.6',
    reads: {
      route: () => 'openai',
      activeEntry: () => ({ ...subEntry, provider: 'openai', kind: 'oauth', custodian: 'openai-accounts', identity: { plan: 'plus' } }),
      openaiObserved: () => ({ primary: { usedPct: 12, windowMinutes: 300, observedAtMs: NOW }, secondary: { usedPct: 78, windowMinutes: 10080, observedAtMs: NOW } }),
      openaiLimited: () => ({ state: 'clear' }),
      spend: () => spend,
    } as Reads,
  })
  check('an OpenAI subscription binds on its worst band, worded as its window', gpt.binding?.window.key === 'wk' && gpt.binding?.windowName === 'weekly window' && gpt.binding?.claim === undefined, JSON.stringify(gpt.binding))
  const nothing = owner.activeSourceUsage({ model: 'glm-4.7', reads: { route: () => 'zai', zaiKeyPresent: () => true, spend: () => spend } as Reads })
  check('a lane with no percent window binds on nothing (never a fabricated window)', nothing.binding === undefined)
}

section('§3 feed + age: live reads say how old they are; stale reads say so; a seed says seeded')
{
  const w = fresh.usageSourceWords
  check("a fresh endpoint read: 'endpoint-fed · read 12 s ago'", w({ source: 'endpoint', observedAtMs: NOW - 12_000, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW) === 'endpoint-fed · read 12 s ago', w({ source: 'endpoint', observedAtMs: NOW - 12_000, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW))
  check("a header read three minutes old is live at the response horizon: 'header-fed · read 3 min ago'", w({ source: 'headers', observedAtMs: NOW - 3 * MIN }, NOW) === 'header-fed · read 3 min ago')
  check("a polled read one missed poll old is still LIVE: 'endpoint-fed · read 1 min ago'", w({ source: 'endpoint', observedAtMs: NOW - 90_000 }, NOW) === 'endpoint-fed · read 1 min ago', w({ source: 'endpoint', observedAtMs: NOW - 90_000 }, NOW))
  check("a polled read past TWICE the poll TTL is STALE: 'endpoint-fed · stale · last read 2 min ago'", w({ source: 'endpoint', observedAtMs: NOW - 2 * MIN - 1_000 }, NOW) === 'endpoint-fed · stale · last read 2 min ago', w({ source: 'endpoint', observedAtMs: NOW - 2 * MIN - 1_000 }, NOW))
  check("a subscription read past its five-minute horizon is STALE: 'endpoint-fed · stale · last read 12 min ago'", w({ source: 'endpoint', observedAtMs: NOW - 12 * MIN, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW) === 'endpoint-fed · stale · last read 12 min ago')
  check("a day-old header read: 'header-fed · stale · last read 1 d ago'", w({ source: 'headers', observedAtMs: NOW - 25 * HOUR }, NOW) === 'header-fed · stale · last read 1 d ago')
  check("a seed says 'seeded' — a fixture never ages into a live read", w({ source: 'seed', observedAtMs: NOW - 10 * HOUR }, NOW) === 'seeded' && w({ source: 'seed' }, NOW) === 'seeded')
  check('an unstamped record names its feed alone', w({ source: 'endpoint' }, NOW) === 'endpoint-fed')
  check('nothing to say when neither feed nor stamp exists', w({}, NOW) === undefined)
  check("the narrow stale tail: '↻12m' while stale, nothing while live", fresh.usageStaleTail({ source: 'endpoint', observedAtMs: NOW - 12 * MIN }, NOW) === '↻12m' && fresh.usageStaleTail({ source: 'endpoint', observedAtMs: NOW - 12_000 }, NOW) === undefined)
  check('the age words: 12 s · 3 min · 2 h 5 min · 3 d', fresh.formatUsageAge(12_000) === '12 s' && fresh.formatUsageAge(3 * MIN) === '3 min' && fresh.formatUsageAge(2 * HOUR + 5 * MIN) === '2 h 5 min' && fresh.formatUsageAge(3 * 24 * HOUR) === '3 d')
  check('the one poll TTL is a minute, and every polling reader imports it', fresh.USAGE_POLL_TTL_MS === 60_000 && ['src/services/providers/openrouter/openrouterUsageState.ts', 'src/services/providers/deepseek/deepseekUsageState.ts', 'src/services/providers/moonshot/moonshotUsageState.ts'].every(f => src(f).includes('USAGE_POLL_TTL_MS')))
  limits.resetLimitsForCredentialSwitch()
  const iso = new Date(NOW + HOUR).toISOString()
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: 36, resets_at: iso }, seven_day: { utilization: 44, resets_at: iso }, seven_day_fable: { utilization: 87, resets_at: iso } }, undefined, NOW - 30_000)
  const folded = owner.anthropicWindowViews()
  const pools = owner.anthropicPoolWindowViews()
  check('the folded pair names the endpoint feed, the fold\'s stamp and the poll horizon', folded.every(v => v.source === 'endpoint' && v.observedAtMs === NOW - 30_000 && v.freshForMs === fresh.usageStaleAfterMs()), JSON.stringify(folded))
  check('the folded pool names the endpoint feed and the same stamp', pools.length === 1 && pools[0]?.source === 'endpoint' && pools[0]?.observedAtMs === NOW - 30_000)
  check("…so the words read 'endpoint-fed · read 30 s ago'", w(folded[0]!, NOW) === 'endpoint-fed · read 30 s ago')
  check("…and twelve minutes on, 'endpoint-fed · stale · last read 12 min ago'", w(folded[0]!, NOW + 12 * MIN - 30_000) === 'endpoint-fed · stale · last read 12 min ago')
  const stale = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads({ readAtMs: NOW - 12 * MIN }) })
  check('a stale view is stale by the one test every renderer uses', owner.usageViewIsStale(stale.windows[0]!, NOW) && owner.usageViewIsStale(stale.pools[0]!, NOW))
  limits.resetLimitsForCredentialSwitch()
}

section('§4 credits: the provider-stated balance with feed + age, or the honest "not reported by the provider"')
{
  const line = (view: ReturnType<typeof owner.usageForProvider>, style: 'prose' | 'compact' = 'prose'): string | undefined => owner.usageCreditsLine(view.credits, NOW, style)
  const capped = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: 20, limitRemaining: 7.5, usage: 12.5, observedAtMs: NOW - 5_000 } as never }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend })
  check("OpenRouter, capped key: 'credits: 7.50 remaining under the key cap · endpoint-fed · read 5 s ago'", line(capped) === 'credits: 7.50 remaining under the key cap · endpoint-fed · read 5 s ago', line(capped))
  check("…the rail's compact spelling: 'credits cap 7.50'", line(capped, 'compact') === 'credits cap 7.50', line(capped, 'compact'))
  const cappedStale = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: 20, limitRemaining: 7.5, usage: 12.5, observedAtMs: NOW - 3 * MIN } as never }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend })
  check("…three minutes past the poll TTL: 'stale · last read 3 min ago', and '↻3m' in the rail", line(cappedStale) === 'credits: 7.50 remaining under the key cap · endpoint-fed · stale · last read 3 min ago' && line(cappedStale, 'compact') === 'credits cap 7.50 ↻3m', `${line(cappedStale)} | ${line(cappedStale, 'compact')}`)
  const uncapped = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: null, limitRemaining: null, usage: 12.5, observedAtMs: NOW } as never }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend })
  check('OpenRouter, uncapped key: the key endpoint states no balance — said so, never a figure', uncapped.credits?.state === 'unreported' && (line(uncapped) ?? '').includes('states no balance for an uncapped key') && line(uncapped, 'compact') === 'credits not stated', line(uncapped))
  const unread = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: null }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend })
  check("OpenRouter, nothing polled yet: 'not read yet — /usage samples the key endpoint'", line(unread) === 'credits: not read yet — /usage samples the key endpoint' && line(unread, 'compact') === 'credits not read yet')
  const deepseek = owner.usageForProvider('deepseek', { laneCredentialed: () => true, deepseekBalance: () => ({ observedAtMs: NOW - 2_000, isAvailable: true, balances: [{ currency: 'USD', totalBalance: '12.34' }] }), spend: () => spend })
  check("DeepSeek: the balance endpoint's figure verbatim — 'credits: USD 12.34 · endpoint-fed · read 2 s ago'", line(deepseek) === 'credits: USD 12.34 · endpoint-fed · read 2 s ago', line(deepseek))
  check("…and the balance field still carries the same figure (one fact)", deepseek.balance?.display === 'USD 12.34')
  const deepseekUnread = owner.usageForProvider('deepseek', { laneCredentialed: () => true, deepseekBalance: () => null, spend: () => spend })
  check("DeepSeek, not polled yet: 'not read yet — /usage samples the balance endpoint'", line(deepseekUnread) === 'credits: not read yet — /usage samples the balance endpoint')
  const moonshot = owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'api-key' }), moonshotBalance: () => ({ observedAtMs: NOW - 4_000, availableBalance: 5.5 }), spend: () => spend })
  check("Moonshot key: 'credits: USD 5.5 · endpoint-fed · read 4 s ago'", line(moonshot) === 'credits: USD 5.5 · endpoint-fed · read 4 s ago', line(moonshot))
  const keyEntry = { ...subEntry, id: 'fx-key', kind: 'api-key' } as const
  const noRoad: Array<[string, ReturnType<typeof owner.usageForProvider>]> = [
    ['a first-party API key', owner.usageForProvider('anthropic', { activeEntry: () => ({ ...keyEntry }), spend: () => spend })],
    ['an OpenAI API key', owner.usageForProvider('openai', { activeEntry: () => ({ ...keyEntry, provider: 'openai', custodian: 'openai-accounts' }), spend: () => spend })],
    ['a Z.AI key', owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend })],
    ['a Gemini key', owner.usageForProvider('gemini', { geminiAccount: () => ({ kind: 'api-key' } as never), geminiLimited: () => ({ state: 'clear' }), spend: () => spend })],
    ['a Hugging Face token', owner.usageForProvider('huggingface', { huggingfaceAccount: () => ({ kind: 'api-key' } as never), huggingfaceLimited: () => ({ state: 'clear' }), huggingfaceRate: () => null, spend: () => spend })],
    ['a custom endpoint', owner.usageForProvider('openai-compat', { laneCredentialed: () => true, spend: () => spend })],
  ]
  for (const [name, view] of noRoad) {
    check(`${name}: 'credits: not reported by the provider'`, line(view) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && line(view, 'compact') === 'credits not reported', line(view))
  }
  check('the one spelling', owner.CREDITS_UNREPORTED_WORDS === 'not reported by the provider')
  const googleSignIn = owner.usageForProvider('gemini', { geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }), geminiLimited: () => ({ state: 'clear' }), spend: () => spend })
  check("a Google sign-in on the Gemini lane: 'credits: not reported by the provider' · 'credits not reported' (Google states no figure to it), under the 'Google sign-in' tier", line(googleSignIn) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && line(googleSignIn, 'compact') === 'credits not reported' && googleSignIn.tier === 'Google sign-in' && googleSignIn.figures === undefined, `${line(googleSignIn)} | ${googleSignIn.tier}`)
  const hfSignInReads = (observedAtMs: number): Reads => ({ huggingfaceAccount: () => ({ kind: 'oauth', label: 'Hugging Face account (fixture)', keySource: 'oauth' }) as never, huggingfaceLimited: () => ({ state: 'clear' }), huggingfaceRate: () => null, huggingfaceAccountFacts: () => ({ observedAtMs, accountType: 'user', isPro: true, canPay: true, periodEndMs: NOW + 20 * 24 * HOUR }), huggingfaceAccountFactsFailure: () => null, spend: () => spend })
  const hfSignIn = owner.usageForProvider('huggingface', hfSignInReads(NOW - 3_000))
  check("a Hugging Face sign-in: the credits line keeps the one spelling; the tier is the stated plan ('Hugging Face PRO'); the plan figure reads 'PRO' · 'plan · payment method on file' with 'endpoint-fed · read 3 s ago'", line(hfSignIn) === `credits: ${owner.CREDITS_UNREPORTED_WORDS}` && hfSignIn.tier === 'Hugging Face PRO' && hfSignIn.figures?.[0]?.key === 'plan' && hfSignIn.figures[0].value === 'PRO' && hfSignIn.figures[0].label === 'plan · payment method on file' && fresh.usageSourceWords(hfSignIn.figures[0], NOW) === 'endpoint-fed · read 3 s ago', JSON.stringify({ line: line(hfSignIn), tier: hfSignIn.tier, figures: hfSignIn.figures }))
  const hfStale = owner.usageForProvider('huggingface', hfSignInReads(NOW - 3 * MIN))
  check("…three minutes on, the plan figure says 'endpoint-fed · stale · last read 3 min ago' — never painted as current", fresh.usageSourceWords(hfStale.figures![0]!, NOW) === 'endpoint-fed · stale · last read 3 min ago', fresh.usageSourceWords(hfStale.figures![0]!, NOW))
  const hfSummary = owner.usageSummaryWords(hfSignIn, NOW)
  check("the Hugging Face sign-in's summary leads with the stated plan tier and carries the absence (whoami-v2 named) and the credits line", hfSummary.startsWith('Hugging Face PRO · ') && hfSummary.includes('whoami-v2') && hfSummary.includes(`credits: ${owner.CREDITS_UNREPORTED_WORDS}`) && !/USD/.test(hfSummary), hfSummary)
  const gptFixture = JSON.parse(src('scripts/providers/fixtures/openai-chatgpt-usage.json'))
  const openaiState = await import('../../src/services/providers/openai/openaiLimitState.ts')
  openaiState.__resetOpenaiLimitStateForTest()
  openaiState.recordOpenaiUsageResponse(gptFixture.body, NOW - 5_000)
  const gpt = owner.usageForProvider('openai', { activeEntry: () => ({ ...subEntry, provider: 'openai', custodian: 'openai-accounts' }), openaiObserved: openaiState.openaiObservedUsage, spend: () => spend })
  check('ChatGPT: the fixture balance is stamped and readable beside the plan windows', line(gpt) === 'credits: 62,500 · endpoint-fed · read 5 s ago' && line(gpt, 'compact') === 'credits 62.5k' && gpt.windows[0]?.usedPct === 99)
  check('ChatGPT: the balance becomes stale at the same feed horizon as the meter', owner.usageViewIsStale(gpt.credits!, NOW + 180_000) && owner.usageViewIsStale(gpt.windows[0]!, NOW + 180_000))
  openaiState.forgetOpenaiLimitSource('chatgpt-subscription')
  check('ChatGPT: without an observation the words say so, never zero', owner.usageCreditsLine(owner.openaiSubscriptionCredits({ openaiObserved: openaiState.openaiObservedUsage }), NOW) === 'credits: not stated on this reply yet')
  const kimi = owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'kimi-oauth' }), kimiManagedUsage: () => ({ observedAtMs: NOW, windows: [{ windowMinutes: 300, used: 1, limit: 10 }] }), spend: () => spend })
  const local = owner.usageForProvider('local', { localAccount: () => ({ kind: 'keyless', label: 'Ollama', serverCount: 1, modelCount: 2 }) as never, spend: () => spend })
  check('a local server carries no credits line (nothing is its meter)', local.credits === undefined)
  check('a Kimi sign-in without a wallet names the checked usage and membership billing views', kimi.credits?.state === 'unreported' && line(kimi)?.includes('Kimi /usages states no Extra Usage balance') === true && line(kimi)?.includes('Kimi Code Console') === true && line(kimi, 'compact') === 'credits not stated', line(kimi))
  const kimiWallet = owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'kimi-oauth' }), kimiManagedUsage: () => ({ observedAtMs: NOW - 4_000, windows: [], extraUsage: { balance: '12.34', currency: 'CNY' } }), spend: () => spend })
  check('Kimi Extra Usage carries its stated currency and the managed read stamp', line(kimiWallet) === 'credits: CNY 12.34 Extra Usage balance · endpoint-fed · read 4 s ago' && line(kimiWallet, 'compact') === 'credits CNY 12.34 extra', line(kimiWallet))
  const extra = (over: Partial<import('../../src/services/anthropicLimits.ts').AnthropicExtraUsageRecord>, readAtMs = NOW - 10_000): Reads => ({
    ...subscriptionReads(),
    anthropicExtraUsage: () => ({ stated: true, enabled: true, used: { amount: 1240, currency: 'USD', exponent: 2 }, limit: { amount: 5000, currency: 'USD', exponent: 2 }, period: 'month', utilizationPct: 24.8, source: 'endpoint', observedAtMs: readAtMs, ...over }),
  }) as Reads
  const subOn = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({}) })
  check("the first-party subscription carries the extra-usage figure as its credits line: 'credits: extra usage USD 12.40 of 50.00 this month · endpoint-fed · read 10 s ago'", line(subOn) === 'credits: extra usage USD 12.40 of 50.00 this month · endpoint-fed · read 10 s ago', line(subOn))
  check("…the rail's compact spelling: 'credits extra 12.40/50'", line(subOn, 'compact') === 'credits extra 12.40/50', line(subOn, 'compact'))
  check('…the figure is the endpoint\'s own, stamped and reported (never a computed spend)', subOn.credits?.state === 'reported' && subOn.credits.source === 'endpoint' && subOn.credits.observedAtMs === NOW - 10_000 && subOn.credits.freshForMs === fresh.usageStaleAfterMs())
  const subStale = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({}, NOW - 12 * MIN) })
  check("…twelve minutes on: 'stale · last read 12 min ago', and '↻12m' in the rail", line(subStale) === 'credits: extra usage USD 12.40 of 50.00 this month · endpoint-fed · stale · last read 12 min ago' && line(subStale, 'compact') === 'credits extra 12.40/50 ↻12m', `${line(subStale)} | ${line(subStale, 'compact')}`)
  const subReached = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ used: { amount: 5000, currency: 'USD', exponent: 2 }, limitReached: true }) })
  check("a reached spend limit rides the words: 'extra usage USD 50.00 of 50.00 this month · limit reached'", (line(subReached) ?? '').startsWith('credits: extra usage USD 50.00 of 50.00 this month · limit reached'), line(subReached))
  const subNoCap = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ limit: undefined, period: undefined }) })
  check("no stated cap ⇒ the used figure alone: 'extra usage USD 12.40' · 'extra 12.40'", (line(subNoCap) ?? '').startsWith('credits: extra usage USD 12.40 · ') && line(subNoCap, 'compact') === 'credits extra 12.40', line(subNoCap))
  const subBalance = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ balance: { amount: 3000, currency: 'USD', exponent: 2 } }) })
  check("a stated prepaid balance rides beside the figure: '… this month · balance USD 30.00'", (line(subBalance) ?? '').includes(' this month · balance USD 30.00 · '), line(subBalance))
  const subOff = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ enabled: false, used: undefined, limit: undefined, period: undefined, utilizationPct: undefined }) })
  check("extra usage off: 'credits: extra usage off' · 'credits extra off' (unreported, never a zero)", subOff.credits?.state === 'unreported' && line(subOff) === 'credits: extra usage off' && line(subOff, 'compact') === 'credits extra off', line(subOff))
  const subOut = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ enabled: false, used: undefined, limit: undefined, period: undefined, disabledReason: 'out_of_credits' }) })
  check("…with the provider's reason in plain words: 'credits: extra usage off — out of credits'", line(subOut) === 'credits: extra usage off — out of credits', line(subOut))
  const temporaryOff = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ enabled: false, disabledReason: 'org_level_disabled_until' }) })
  check('a temporary organisation restriction is a complete sentence, not an unfinished reason code', line(temporaryOff) === 'credits: Extra usage is temporarily disabled by your organisation. Included plan usage continues within its limits.', line(temporaryOff))
  const subOnNoFigure = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ used: undefined, limit: undefined, period: undefined }) })
  check("on, but no figure stated: 'credits: extra usage on — the endpoint states no figure' · 'credits not stated'", line(subOnNoFigure) === `credits: ${owner.EXTRA_USAGE_NO_FIGURE_WORDS}` && line(subOnNoFigure, 'compact') === 'credits not stated', line(subOnNoFigure))
  const subUnstated = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra({ stated: false, enabled: false, used: undefined, limit: undefined, period: undefined }) })
  check("an answer without the block: 'credits: not stated by the endpoint'", line(subUnstated) === 'credits: not stated by the endpoint' && line(subUnstated, 'compact') === 'credits not stated', line(subUnstated))
  const subUnread = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: { ...subscriptionReads(), anthropicExtraUsage: () => null } as Reads })
  check("nothing observed yet: 'credits: not read yet — /usage samples the usage endpoint' · 'credits not read yet'", line(subUnread) === `credits: ${owner.EXTRA_USAGE_NOT_READ_WORDS}` && line(subUnread, 'compact') === 'credits not read yet', line(subUnread))
  const figures = [subOn, subStale, subReached, subBalance, subOff, subOut, subOnNoFigure, subUnstated, subUnread].map(v => `credits: ${v.credits?.display ?? v.credits?.reason ?? ''}`)
  check('every figure fits an 80-column row under its label (the feed + age suffix wraps as on every lane); every compact spelling fits the rail (≤ 28 cells)', figures.every(w => w.length <= 80) && [subOn, subStale, subReached, subNoCap, subOff, subOut, subOnNoFigure, subUnstated, subUnread].every(v => (line(v, 'compact') ?? '').length <= 28), JSON.stringify(figures.map(w => w.length)))
  const fixture = JSON.parse(src('scripts/providers/fixtures/anthropic-oauth-usage.json')) as { body: Record<string, unknown> }
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint(fixture.body as never, undefined, NOW - 30_000)
  const observed = owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })
  check("the recorded endpoint answer (extra usage turned off) folds through the real seam: 'credits: extra usage off', stamped by the fold", observed.credits?.state === 'unreported' && line(observed) === 'credits: extra usage off' && observed.credits.observedAtMs === NOW - 30_000 && observed.credits.source === 'endpoint', line(observed))
  check('…and the same fold still lands the pair (5h 20 · 7d 22) — one GET, one seam, no second poll', observed.windows.map(w => `${w.key}=${w.usedPct}`).join(',') === '5h=20,7d=22', JSON.stringify(observed.windows))
  const on = { ...fixture.body, extra_usage: { ...(fixture.body.extra_usage as object), is_enabled: true, user_disabled: false, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'USD', decimal_places: 2 } }
  limits.foldUtilizationFromEndpoint(on as never, undefined, NOW - 5_000)
  const onView = owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })
  check("the endpoint's extra_usage block, enabled, decodes in its own minor units: 'credits: extra usage USD 12.40 of 50.00 this month · endpoint-fed · read 5 s ago'", line(onView) === 'credits: extra usage USD 12.40 of 50.00 this month · endpoint-fed · read 5 s ago', line(onView))
  const spendOnly = { ...fixture.body, extra_usage: undefined, spend: { ...(fixture.body.spend as object), enabled: true, used: { amount_minor: 725, currency: 'USD', exponent: 2 }, limit: { amount_minor: 2000, currency: 'USD', exponent: 2 } } }
  limits.foldUtilizationFromEndpoint(spendOnly as never, undefined, NOW - 5_000)
  const spendView = owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })
  check("the spend block alone (amount_minor + exponent) decodes too, without a period word: 'credits: extra usage USD 7.25 of 20.00 · …'", (line(spendView) ?? '').startsWith('credits: extra usage USD 7.25 of 20.00 · endpoint-fed'), line(spendView))
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: 1, resets_at: new Date(NOW + HOUR).toISOString() } }, undefined, NOW)
  check("an answer that states neither block: 'credits: not stated by the endpoint'", line(owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })) === 'credits: not stated by the endpoint')
  limits.resetLimitsForCredentialSwitch()
  check("a credential switch drops the figure with the windows: 'not read yet'", limits.getEndpointExtraUsage() === null && line(owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })) === `credits: ${owner.EXTRA_USAGE_NOT_READ_WORDS}`)
  const tab = src('src/components/Settings/Usage.tsx')
  check('every source on the tab carries the owner\'s credits line regardless of its shape', tab.includes('<UsageCredits usage={usageForProvider(family)} />') && tab.includes('const line = usageCreditsLine(usage.credits)'))
  const rail = src('src/utils/cockpit/helmTelemetryModel.ts')
  check('the rail\'s api-key block carries the compact credits line', rail.includes("usageCreditsLine(source.credits, now, 'compact')") && rail.includes("creditsOf(usage, 'usage:credits')"))
}

section('§5 never a fabricated zero: unstated pools and null figures are absent')
{
  limits.resetLimitsForCredentialSwitch()
  const iso = new Date(NOW + 5 * 24 * HOUR).toISOString()
  limits.foldUtilizationFromEndpoint(
    {
      five_hour: { utilization: 36, resets_at: iso },
      seven_day: { utilization: 44, resets_at: iso },
      seven_day_fable: { utilization: 87, resets_at: iso },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: iso },
    },
    undefined,
    NOW,
  )
  const pools = owner.anthropicPoolWindowViews()
  check('a stated pool is present at its stated percent (Fable 87)', pools.some(p => p.key === 'seven_day_fable' && Math.round(p.usedPct ?? -1) === 87))
  check('a pool stated as null is absent, never 0% (Opus)', !pools.some(p => p.key === 'seven_day_opus'))
  check('a pool with a null utilization is absent, never 0% (Sonnet)', !pools.some(p => p.key === 'seven_day_sonnet'))
  const view = owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend })
  check('the view carries exactly the stated pool', view.pools.map(p => p.label).join(',') === 'Fable')
  limits.resetLimitsForCredentialSwitch()
  check('a credential switch empties the pools with the pair', owner.anthropicPoolWindowViews().length === 0 && owner.anthropicWindowViews().every(w => w.state === 'unavailable'))
  const zai = owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend })
  check('a family with no usage road has no windows, no pools, no binding — and its absence line', zai.windows.length === 0 && zai.pools.length === 0 && zai.binding === undefined && typeof zai.absence === 'string')
  const summary = owner.usageSummaryWords(owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads({ pools: false }) }), NOW)
  check('a summary never spells a 0% for a pool that was not stated', !/Fable|Opus|Sonnet/.test(summary) && summary.includes('5h 36%') && summary.includes('7d 44%'), summary)
  const empty = owner.usageSummaryWords(owner.usageForProvider('anthropic', { activeEntry: () => ({ ...subEntry }), anthropicPlan: () => 'max', spend: () => spend }), NOW)
  check("a subscription with nothing observed says 'no usage read' — never 0%", empty.includes(fresh.NO_USAGE_READ_WORDS) && !empty.includes('0%'), empty)
  const rail = src('src/utils/cockpit/helmTelemetryModel.ts')
  check('the rail leads its unread state with the one spelling', rail.includes('${NO_USAGE_READ_WORDS} · fills after first reply'))
}

section("§6 reset instants in the operator's local clock")
{
  const at = NOW + 2 * HOUR + 10 * MIN
  const d = new Date(at)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  const clock = new Date().toDateString() === d.toDateString() ? hhmm : `${weekday} ${hhmm}`
  const words = owner.usageResetWords(at, NOW)
  check(`the reset words carry the local clock (${clock}) and the countdown`, words === `resets ${clock} (in 2h 10m)`, words)
  check('a reset the provider did not state has no words', owner.usageResetWords(undefined, NOW) === undefined)
  const summary = owner.usageSummaryWords(owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads() }), NOW)
  check('the summary spells every window and pool with its local reset', summary.includes(`5h 36% · resets ${clock} (in 2h 10m)`) && summary.includes('Fable 87% · resets ') && summary.includes('(in 22h 51m)'), summary)
  const tab = src('src/components/Settings/Usage.tsx')
  check('the tab\'s reset line is the local locale rendering', tab.includes("date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })"))
}

section('§7 one vocabulary: the feed + freshness words live in one module; no surface spells its own stamp')
{
  const vocabulary = ['endpoint-fed', 'header-fed', 'last read', 'seeded']
  const surfaces = [
    'src/services/providers/providerUsage.ts',
    'src/components/HelmTelemetryRail.tsx',
    'src/utils/cockpit/helmTelemetryModel.ts',
    'src/components/DeckPane.tsx',
    'src/components/MercuryFrame.tsx',
    'src/components/Settings/Usage.tsx',
    'src/utils/healthReport.ts',
  ]
  const home = src('src/services/providers/usageFreshness.ts')
  check('the vocabulary is spelled in its one home', vocabulary.every(word => home.includes(`'${word}`) || home.includes(word)))
  for (const file of surfaces) {
    const text = src(file)
    const code = text
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    check(`${file} spells no vocabulary word of its own`, vocabulary.every(word => !code.includes(`'${word}`) && !code.includes(`\`${word}`) && !code.includes(` ${word} `)), vocabulary.filter(word => code.includes(word)).join(','))
  }
  const tab = src('src/components/Settings/Usage.tsx')
  check("the tab's old per-surface stamps are gone ('observed HH:MM', 'live from the account source')", !tab.includes('observed ${new Date(') && !tab.includes('live from the account source') && !tab.includes('Balance (provider-stated)'))
  check('the tab captions every meter through the one composer', tab.includes('const observed = usageSourceWords(w)') && tab.includes('subtext: observed') && tab.slice(tab.indexOf('function MoonshotUsageSection')).includes('<ObservedWindowMeter'))
  const words = owner.usageSummaryWords(owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: 20, limitRemaining: 7.5, usage: 12.5, observedAtMs: NOW - 5_000 } as never }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend }), NOW)
  check('an engine summary speaks the same words as the first-party one', words.includes('endpoint-fed · read 5 s ago') && words.includes('credits: 7.50 remaining under the key cap'), words)
}

section("§8 /health's usage row is the owner's summary — windows, pools, feed + age, credits")
{
  const view = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads() })
  const words = owner.usageSummaryWords(view, NOW)
  check('the summary leads with the tier and walks the pair then the pools', words.startsWith('Claude Max · 5h 36%') && words.indexOf('7d 44%') !== -1 && words.indexOf('7d 44%') < words.indexOf('Fable 87%') && words.includes('Opus 61%') && words.includes('Sonnet 20%'), words)
  check('…and names the feed and age once for the block', words.includes(' · endpoint-fed · read 10 s ago'), words)
  const key = owner.usageSummaryWords(owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend }), NOW)
  check('an api-key summary carries the tier, the absence and the credits line', key.startsWith('API billing · ') && key.includes('credits: not reported by the provider') && key.includes('No usage road for a general Z.AI key') && key.includes('https://z.ai/manage-apikey/billing'), key)
  const none = owner.usageSummaryWords(owner.usageForProvider('openrouter', { openrouterKeyPresent: () => false, spend: () => spend }), NOW)
  check("a signed-out family's summary is its why-not", none === 'not connected — /logins adds OpenRouter', none)
  const limited = owner.usageSummaryWords({ ...view, limited: { resetsAtMs: NOW + 30 * MIN } }, NOW)
  check('a reached limit rides the summary with its local reset, then what carries the requests', /limit reached · resets (?:[A-Z][a-z]{2} )?\d{2}:\d{2} \(in 30m\) · extra usage not read yet — \/usage samples the usage endpoint$/.test(limited), limited)
}

section('§9 the carry words: a reached window says what carries the requests from here, from the vendor\'s stated facts, or that nothing does')
{
  const prose = (view: { carry?: import('../../src/services/providers/providerUsage.ts').UsageCarryView }): string | undefined => owner.usageCarryWords(view.carry, NOW)
  const compact = (view: { carry?: import('../../src/services/providers/providerUsage.ts').UsageCarryView }): string | undefined => owner.usageCarryWords(view.carry, NOW, 'compact')
  const allowed = { status: 'allowed' as const, unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }
  const extra = (over: Partial<import('../../src/services/anthropicLimits.ts').AnthropicExtraUsageRecord> | null, limits: import('../../src/services/anthropicLimits.ts').AnthropicLimits = allowed, readAtMs = NOW - 10_000): Reads => ({
    ...subscriptionReads(),
    anthropicExtraUsage: () => over === null ? null : { stated: true, enabled: true, used: { amount: 1240, currency: 'USD', exponent: 2 }, limit: { amount: 5000, currency: 'USD', exponent: 2 }, period: 'month', utilizationPct: 24.8, source: 'endpoint', observedAtMs: readAtMs, ...over },
    anthropicLimits: () => limits,
  }) as Reads
  const sub = (over: Partial<import('../../src/services/anthropicLimits.ts').AnthropicExtraUsageRecord> | null, limits?: import('../../src/services/anthropicLimits.ts').AnthropicLimits, readAtMs?: number) => owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: extra(over, limits, readAtMs) })
  const on = sub({})
  check("Anthropic, extra usage on: 'on extra usage · USD 12.40 of 50.00 this month' · 'on extra usage 12.40/50'", on.carry?.state === 'carries' && prose(on) === 'on extra usage · USD 12.40 of 50.00 this month' && compact(on) === 'on extra usage 12.40/50', `${prose(on)} | ${compact(on)}`)
  check('…stamped by the endpoint read', on.carry?.source === 'endpoint' && on.carry.observedAtMs === NOW - 10_000 && on.carry.freshForMs === fresh.usageStaleAfterMs())
  const onNoFigure = sub({ used: undefined, limit: undefined, period: undefined })
  check("on, no figure stated: 'on extra usage — the endpoint states no figure' · 'on extra usage'", onNoFigure.carry?.state === 'carries' && prose(onNoFigure) === 'on extra usage — the endpoint states no figure' && compact(onNoFigure) === 'on extra usage', prose(onNoFigure))
  const capHit = sub({ used: { amount: 5000, currency: 'USD', exponent: 2 }, limitReached: true })
  check("the cap hit: 'extra usage limit reached — nothing carries requests until the reset' · 'extra usage limit reached' (the credits line beside it keeps the figure)", capHit.carry?.state === 'nothing' && prose(capHit) === 'extra usage limit reached — nothing carries requests until the reset' && compact(capHit) === 'extra usage limit reached' && (owner.usageCreditsLine(capHit.credits, NOW) ?? '').startsWith('credits: extra usage USD 50.00 of 50.00 this month · limit reached'), `${prose(capHit)} | ${owner.usageCreditsLine(capHit.credits, NOW)}`)
  const off = sub({ enabled: false, used: undefined, limit: undefined, period: undefined, utilizationPct: undefined })
  check("extra usage off: 'extra usage off — nothing carries requests until the reset' · 'extra usage off'", off.carry?.state === 'nothing' && prose(off) === 'extra usage off — nothing carries requests until the reset' && compact(off) === 'extra usage off', prose(off))
  const offWhy = sub({ enabled: false, used: undefined, limit: undefined, period: undefined, disabledReason: 'out_of_credits' })
  check("…with the provider's reason: 'extra usage off (out of credits) — nothing carries requests until the reset'", prose(offWhy) === 'extra usage off (out of credits) — nothing carries requests until the reset' && compact(offWhy) === 'extra usage off', prose(offWhy))
  const unstated = sub({ stated: false, enabled: false, used: undefined, limit: undefined, period: undefined })
  check("an answer without the block: 'extra usage not stated by the endpoint' · 'extra usage not stated'", unstated.carry?.state === 'unstated' && prose(unstated) === 'extra usage not stated by the endpoint' && compact(unstated) === 'extra usage not stated', prose(unstated))
  const unread = sub(null)
  check("nothing read: 'extra usage not read yet — /usage samples the usage endpoint' · 'extra usage not read yet'", unread.carry?.state === 'unstated' && prose(unread) === `extra usage ${owner.EXTRA_USAGE_NOT_READ_WORDS}` && compact(unread) === 'extra usage not read yet', prose(unread))
  const headersOn = sub(null, { status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'five_hour' })
  check("nothing read but the reply headers say the account is using extra usage: 'on extra usage' (header-fed, no figure)", headersOn.carry?.state === 'carries' && prose(headersOn) === 'on extra usage' && compact(headersOn) === 'on extra usage' && headersOn.carry.source === 'headers', prose(headersOn))
  const headersOut = sub({}, { status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', rateLimitType: 'five_hour' })
  check("a wall whose headers reject extra usage for credit: 'extra usage out of credits — nothing carries requests until the reset' (the wall's own fact beats the endpoint's older figure)", headersOut.carry?.state === 'nothing' && prose(headersOut) === 'extra usage out of credits — nothing carries requests until the reset' && compact(headersOut) === 'extra usage out of credits', prose(headersOut))
  const headersRefused = sub({}, { status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', rateLimitType: 'five_hour' })
  check("…with another stated reason: 'extra usage off (org level disabled) — nothing carries requests until the reset'", prose(headersRefused) === 'extra usage off (org level disabled) — nothing carries requests until the reset' && compact(headersRefused) === 'extra usage off', prose(headersRefused))
  const headersBare = sub({}, { status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', rateLimitType: 'five_hour' })
  check("…and with none stated: 'extra usage refused — nothing carries requests until the reset'", prose(headersBare) === 'extra usage refused — nothing carries requests until the reset' && compact(headersBare) === 'extra usage refused', prose(headersBare))
  const headersAllowedWindow = sub({}, { status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', rateLimitType: 'five_hour' })
  check('a rejected overage header behind an ALLOWED window does not override the endpoint (no wall stands)', headersAllowedWindow.carry?.state === 'carries' && prose(headersAllowedWindow) === 'on extra usage · USD 12.40 of 50.00 this month', prose(headersAllowedWindow))
  const stale = sub({}, allowed, NOW - 12 * MIN)
  check("twelve minutes on, the prose says so and the rail tails '↻12m': 'on extra usage · USD 12.40 of 50.00 this month · stale · last read 12 min ago'", prose(stale) === 'on extra usage · USD 12.40 of 50.00 this month · stale · last read 12 min ago' && compact(stale) === 'on extra usage 12.40/50 ↻12m', `${prose(stale)} | ${compact(stale)}`)

  const gptFixture = JSON.parse(src('scripts/providers/fixtures/openai-chatgpt-usage.json'))
  const openaiState = await import('../../src/services/providers/openai/openaiLimitState.ts')
  const gptEntry = { ...subEntry, provider: 'openai', custodian: 'openai-accounts' } as const
  const gptWith = (credits: Record<string, unknown> | null, observedAtMs = NOW - 5_000) => {
    openaiState.__resetOpenaiLimitStateForTest()
    openaiState.recordOpenaiUsageResponse({ ...gptFixture.body, credits }, observedAtMs)
    return owner.usageForProvider('openai', { activeEntry: () => ({ ...gptEntry }), openaiObserved: openaiState.openaiObservedUsage, spend: () => spend })
  }
  const gpt = gptWith(gptFixture.body.credits)
  check("ChatGPT on the recorded fixture (62,500 credits): 'on credits · 62,500 left' · 'on credits 62.5k', stamped by the usage endpoint", gpt.carry?.state === 'carries' && prose(gpt) === 'on credits · 62,500 left' && compact(gpt) === 'on credits 62.5k' && gpt.carry.source === 'endpoint' && gpt.carry.observedAtMs === NOW - 5_000, `${prose(gpt)} | ${compact(gpt)}`)
  const gptUnlimited = gptWith({ has_credits: true, unlimited: true })
  check("unlimited credits: 'on credits · unlimited' · 'on credits unlimited'", gptUnlimited.carry?.state === 'carries' && prose(gptUnlimited) === 'on credits · unlimited' && compact(gptUnlimited) === 'on credits unlimited', prose(gptUnlimited))
  const gptNone = gptWith({ has_credits: false, unlimited: false })
  check("no credits: 'no credits — nothing carries requests until the reset' · 'no credits'", gptNone.carry?.state === 'nothing' && prose(gptNone) === 'no credits — nothing carries requests until the reset' && compact(gptNone) === 'no credits', prose(gptNone))
  const gptNoBalance = gptWith({ has_credits: true, unlimited: false })
  check("credits stated without a balance: 'on credits — the balance is not stated' · 'on credits'", gptNoBalance.carry?.state === 'carries' && prose(gptNoBalance) === 'on credits — the balance is not stated' && compact(gptNoBalance) === 'on credits', prose(gptNoBalance))
  const gptStale = gptWith(gptFixture.body.credits, NOW - 3 * MIN)
  check("three minutes past the endpoint horizon: 'on credits · 62,500 left · stale · last read 3 min ago' · 'on credits 62.5k ↻3m'", prose(gptStale) === 'on credits · 62,500 left · stale · last read 3 min ago' && compact(gptStale) === 'on credits 62.5k ↻3m', `${prose(gptStale)} | ${compact(gptStale)}`)
  openaiState.__resetOpenaiLimitStateForTest()
  const gptUnread = owner.usageForProvider('openai', { activeEntry: () => ({ ...gptEntry }), openaiObserved: openaiState.openaiObservedUsage, spend: () => spend })
  check("nothing read: 'credits not read yet — /usage samples the usage endpoint' · 'credits not read yet'", gptUnread.carry?.state === 'unstated' && prose(gptUnread) === owner.OPENAI_CREDITS_NOT_READ_WORDS && compact(gptUnread) === 'credits not read yet', prose(gptUnread))
  openaiState.recordOpenaiRateHeaders(new Headers({ 'x-codex-credits-has-credits': 'false', 'x-codex-credits-unlimited': 'false' }), () => NOW - 1_000)
  const gptHeaders = owner.usageForProvider('openai', { activeEntry: () => ({ ...gptEntry }), openaiObserved: openaiState.openaiObservedUsage, spend: () => spend })
  check("a reply's own headers state the credits too: 'no credits — nothing carries requests until the reset', header-fed", gptHeaders.carry?.state === 'nothing' && prose(gptHeaders) === 'no credits — nothing carries requests until the reset' && gptHeaders.carry.source === 'headers', prose(gptHeaders))
  openaiState.__resetOpenaiLimitStateForTest()

  type KimiManagedUsageViewT = import('../../src/services/providers/providerUsage.ts').KimiManagedUsageView
  const kimi = (managed: KimiManagedUsageViewT | null, error?: string) => owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'kimi-oauth' }), kimiManagedUsage: () => managed, ...(error !== undefined ? { kimiManagedError: () => error } : {}), spend: () => spend })
  const wallet = kimi({ observedAtMs: NOW - 4_000, windows: [], extraUsage: { balance: '12.34', currency: 'CNY' } })
  check("Kimi with a wallet: 'on Extra Usage · CNY 12.34 left' · 'on Extra Usage CNY 12.34'", wallet.carry?.state === 'carries' && prose(wallet) === 'on Extra Usage · CNY 12.34 left' && compact(wallet) === 'on Extra Usage CNY 12.34', `${prose(wallet)} | ${compact(wallet)}`)
  const walletEmpty = kimi({ observedAtMs: NOW - 4_000, windows: [], extraUsage: { balance: '0', currency: 'CNY' } })
  check("an empty wallet: 'Extra Usage balance CNY 0 — nothing carries requests until the reset'", walletEmpty.carry?.state === 'nothing' && prose(walletEmpty) === 'Extra Usage balance CNY 0 — nothing carries requests until the reset', prose(walletEmpty))
  const noWallet = kimi({ observedAtMs: NOW, windows: [{ windowMinutes: 300, used: 1, limit: 10 }] })
  check("no wallet stated: the reason — 'no Extra Usage balance stated — Kimi Code Console shows membership billing' · 'Extra Usage not stated'", noWallet.carry?.state === 'unstated' && prose(noWallet) === owner.KIMI_EXTRA_USAGE_UNSTATED_WORDS && compact(noWallet) === 'Extra Usage not stated', prose(noWallet))
  const kimiUnread = kimi(null)
  check("nothing read: 'Extra Usage not read yet — /usage samples Kimi /usages'", kimiUnread.carry?.state === 'unstated' && prose(kimiUnread) === owner.KIMI_EXTRA_USAGE_NOT_READ_WORDS && compact(kimiUnread) === 'Extra Usage not read yet', prose(kimiUnread))
  const kimiFailed = kimi(null, 'Kimi usage read failed · HTTP 503')
  check("a failed read carries the reader's own words", kimiFailed.carry?.state === 'unstated' && prose(kimiFailed) === 'Kimi usage read failed · HTTP 503' && compact(kimiFailed) === 'Extra Usage not read', prose(kimiFailed))

  const keyEntry = { ...subEntry, id: 'fx-key', kind: 'api-key' } as const
  const others: Array<[string, ReturnType<typeof owner.usageForProvider>]> = [
    ['a first-party API key', owner.usageForProvider('anthropic', { activeEntry: () => ({ ...keyEntry }), spend: () => spend })],
    ['an OpenAI API key', owner.usageForProvider('openai', { activeEntry: () => ({ ...keyEntry, provider: 'openai', custodian: 'openai-accounts' }), spend: () => spend })],
    ['a Z.AI key', owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend })],
    ['a GLM coding plan', owner.usageForProvider('zai', { zaiKeyPresent: () => true, zaiAccount: () => ({ plan: 'coding', source: 'stored' }), zaiQuota: () => null, zaiQuotaFailure: () => null, spend: () => spend })],
    ['an OpenRouter key', owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: null }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend })],
    ['a Gemini sign-in', owner.usageForProvider('gemini', { geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }), geminiLimited: () => ({ state: 'clear' }), spend: () => spend })],
    ['a Hugging Face token', owner.usageForProvider('huggingface', { huggingfaceAccount: () => ({ kind: 'api-key' } as never), huggingfaceLimited: () => ({ state: 'clear' }), huggingfaceRate: () => null, spend: () => spend })],
    ['a DeepSeek key', owner.usageForProvider('deepseek', { laneCredentialed: () => true, deepseekBalance: () => null, spend: () => spend })],
    ['a Moonshot key', owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'api-key' }), moonshotBalance: () => null, spend: () => spend })],
    ['an xAI key', owner.usageForProvider('xai', { laneCredentialed: () => true, xaiManagementKeyPresent: () => false, spend: () => spend })],
    ['a custom endpoint', owner.usageForProvider('openai-compat', { laneCredentialed: () => true, spend: () => spend })],
    ['a local server', owner.usageForProvider('local', { localAccount: () => ({ kind: 'keyless', label: 'Ollama', serverCount: 1, modelCount: 2 }) as never, spend: () => spend })],
  ]
  for (const [name, view] of others) {
    check(`${name}: the family states nothing about carrying, said in one clause — '${owner.CARRY_UNSTATED_WORDS}' · '${owner.CARRY_UNSTATED_COMPACT}'`, view.carry?.state === 'unstated' && prose(view) === owner.CARRY_UNSTATED_WORDS && compact(view) === owner.CARRY_UNSTATED_COMPACT, `${prose(view)} | ${compact(view)}`)
  }
  const signedOut = owner.usageForProvider('openrouter', { openrouterKeyPresent: () => false, spend: () => spend })
  check('a signed-out family carries no words (nothing is connected to carry anything)', signedOut.carry === undefined)

  const every = [on, onNoFigure, capHit, off, offWhy, unstated, unread, headersOn, headersOut, headersRefused, headersBare, gpt, gptUnlimited, gptNone, gptNoBalance, gptUnread, gptHeaders, wallet, walletEmpty, noWallet, kimiUnread, ...others.map(([, v]) => v)]
  check('every prose spelling fits an 80-column row (and so a 120-column one); every compact spelling fits the rail (≤ 28 cells)', every.every(v => (prose(v) ?? '').length <= 80 && (compact(v) ?? '').length <= 28), JSON.stringify(every.map(v => [prose(v)?.length, compact(v)?.length])))
  const longestReason = sub({ enabled: false, used: undefined, limit: undefined, period: undefined, disabledReason: 'org_service_zero_credit_limit' })
  check("the longest wire reason still fits a 120-column row: 'extra usage off (org service zero credit limit) — nothing carries requests until the reset'", prose(longestReason) === 'extra usage off (org service zero credit limit) — nothing carries requests until the reset' && (prose(longestReason) ?? '').length <= 120, prose(longestReason))

  type UsageWindowViewT = import('../../src/services/providers/providerUsage.ts').UsageWindowView
  const wk = (usedPct: number, over: Partial<UsageWindowViewT> = {}): UsageWindowViewT => ({ key: 'wk', label: 'wk', state: 'live', usedPct, resetsAtMs: NOW + 6 * 24 * HOUR, source: 'endpoint', observedAtMs: NOW - 5_000, ...over })
  check("the reached predicate: an observed wall is 'wall'", owner.usageWindowReached({ windows: [wk(40)], pools: [], limited: { resetsAtMs: NOW + 30 * MIN } }, NOW) === 'wall')
  check("…a live window painted at 100% (99.6 rounds up) is 'full' without a wall", owner.usageWindowReached({ windows: [wk(100)], pools: [] }, NOW) === 'full' && owner.usageWindowReached({ windows: [wk(99.6)], pools: [] }, NOW) === 'full' && owner.usageWindowReached({ windows: [], pools: [wk(100, { key: 'seven_day_fable', label: 'Fable' })] }, NOW) === 'full')
  check('…99.4 paints 99% and is not reached; a full window whose reset has passed is not reached; a window stated without a percent is not reached', owner.usageWindowReached({ windows: [wk(99.4)], pools: [] }, NOW) === null && owner.usageWindowReached({ windows: [wk(100, { resetsAtMs: NOW - 1 })], pools: [] }, NOW) === null && owner.usageWindowReached({ windows: [wk(100, { usedPct: undefined })], pools: [] }, NOW) === null)
  const gptFull = { ...gptWith(gptFixture.body.credits), windows: [wk(100)] }
  const gptWalled = { ...gptFull, windows: [wk(99)], limited: { resetsAtMs: NOW + 30 * MIN } }
  check("the reached words, prose: 'limit reached · resets HH:MM (in 30m) · on credits · 62,500 left'", /^limit reached · resets (?:[A-Z][a-z]{2} )?\d{2}:\d{2} \(in 30m\) · on credits · 62,500 left$/.test(owner.usageReachedWords(gptWalled, NOW) ?? ''), owner.usageReachedWords(gptWalled, NOW))
  check("…compact: 'limit reached · resets 30m · on credits 62.5k'", owner.usageReachedWords(gptWalled, NOW, 'compact') === 'limit reached · resets 30m · on credits 62.5k', owner.usageReachedWords(gptWalled, NOW, 'compact'))
  check("a window at 100% without a wall (OpenAI on credits): '100% · on credits · 62,500 left' · '100% · on credits 62.5k'", owner.usageReachedWords(gptFull, NOW) === '100% · on credits · 62,500 left' && owner.usageReachedWords(gptFull, NOW, 'compact') === '100% · on credits 62.5k', owner.usageReachedWords(gptFull, NOW))
  check('a window short of 100% with no wall has no reached words', owner.usageReachedWords({ ...gptFull, windows: [wk(99)] }, NOW) === undefined)
  const gptSummary = owner.usageSummaryWords(gptFull, NOW)
  check("/health's summary carries them after the window and credits lines", gptSummary.includes('wk 100%') && gptSummary.endsWith(' · 100% · on credits · 62,500 left'), gptSummary)
  const offWalled = owner.usageSummaryWords({ ...off, limited: { resetsAtMs: NOW + 30 * MIN } }, NOW)
  check("…and a walled Claude subscription with extra usage off says nothing carries", offWalled.includes(' · limit reached · resets ') && offWalled.endsWith(' (in 30m) · extra usage off — nothing carries requests until the reset'), offWalled)
  const gptFullReads = { route: () => 'openai', activeEntry: () => ({ ...gptEntry }), openaiObserved: () => ({ primary: { usedPct: 100, windowMinutes: 10080, resetsAtMs: NOW + 6 * 24 * HOUR, observedAtMs: NOW - 5_000, source: 'endpoint' }, credits: { hasCredits: true, unlimited: false, balance: '62500', observedAtMs: NOW - 5_000, source: 'endpoint' } }), openaiLimited: () => ({ state: 'clear' }), spend: () => spend } as Reads
  const fullWarning = providerLimitWarning({ model: 'gpt-5.6', reads: gptFullReads })
  check("the strip warning at 100% carries the words: 'OpenAI: 100% of the weekly window used · resets … · on credits · 62,500 left'", /^OpenAI: 100% of the weekly window used · resets .+ · on credits · 62,500 left$/.test(fullWarning?.text ?? ''), fullWarning?.text ?? '(null)')
  const nearWarning = providerLimitWarning({ model: 'gpt-5.6', reads: { ...gptFullReads, openaiObserved: () => ({ primary: { usedPct: 90, windowMinutes: 10080, resetsAtMs: NOW + 6 * 24 * HOUR, observedAtMs: NOW - 5_000, source: 'endpoint' }, credits: { hasCredits: true, unlimited: false, balance: '62500', observedAtMs: NOW - 5_000, source: 'endpoint' } }) } as Reads })
  check('…and at 90% it does not (the window is not reached)', /^OpenAI: 90% of the weekly window used · resets [^·]+$/.test(nearWarning?.text ?? ''), nearWarning?.text ?? '(null)')
  const claudeFull = providerLimitWarning({ model: 'claude-fable-5-1', reads: { ...extra({}), anthropicWindows: () => ({ fiveHour: { key: '5h', usedPct: 100, resetsAtMs: NOW + HOUR, state: 'live', source: 'endpoint', observedAtMs: NOW - 10_000 }, sevenDay: { key: '7d', usedPct: 44, resetsAtMs: NOW + 6 * 24 * HOUR, state: 'live', source: 'endpoint', observedAtMs: NOW - 10_000 } }) } as never })
  check("a Claude session window at 100% with extra usage on: 'Anthropic: 100% of the session limit used · resets … · on extra usage · USD 12.40 of 50.00 this month'", /^Anthropic: 100% of the session limit used · resets .+ · on extra usage · USD 12\.40 of 50\.00 this month$/.test(claudeFull?.text ?? ''), claudeFull?.text ?? '(null)')

  const refusal = await import('../../src/services/providers/anthropicRefusal.ts')
  const seen = { account: 'a@example.com', observedAtMs: NOW - MIN, resetsAtMs: NOW + 30 * MIN }
  check('the Anthropic refusal words append the carry words after the reset, and stay as they were without them', refusal.anthropicWindowWords(seen, 'extra usage off — nothing carries requests until the reset').endsWith(' · extra usage off — nothing carries requests until the reset') && refusal.anthropicWindowWords(seen).startsWith(`the Anthropic usage window is reached for ${seen.account}, seen at `) && !refusal.anthropicWindowWords(seen).includes(' · ') && refusal.anthropicWindowWords(undefined, 'on extra usage') === 'the Anthropic usage window is reached — the reset time is not known · on extra usage', refusal.anthropicWindowWords(seen, 'extra usage off — nothing carries requests until the reset'))
  const messages = await import('../../src/services/rateLimitMessages.ts')
  const block = messages.composeAnthropicWallRemedies({ carryWords: () => 'extra usage off — nothing carries requests until the reset', slotAppendix: () => 'The other slot is signed in.', upsellEligible: () => true, laneTarget: () => ({ route: 'openai', name: 'OpenAI' }) })
  check("the Anthropic wall row's block leads with the carry words, then the slot, account and lane remedies in their order", block.startsWith('\nextra usage off — nothing carries requests until the reset\nThe other slot is signed in.\n') && block.includes('/logins') && block.includes('lane is usable now') && block.indexOf('/logins') < block.indexOf('lane is usable now'), JSON.stringify(block))
  check('…and a block composed without the read keeps its old lines exactly', messages.composeAnthropicWallRemedies({ slotAppendix: () => 'The other slot is signed in.', upsellEligible: () => false, laneTarget: () => null }) === '\nThe other slot is signed in.')
  const errorsSrc = src('src/services/api/errors.ts')
  check("the wall row reads the carry words from the refusal's own headers", errorsSrc.includes('composeAnthropicWallRemedies({ carryWords: () => anthropicCarryWords(limits) })'))
  check("…and the refusal owner composes them from those headers ahead of the endpoint's older figure", refusal.anthropicCarryWords({ status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }) === 'extra usage out of credits — nothing carries requests until the reset', refusal.anthropicCarryWords({ status: 'rejected', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }))
  const usability = await import('../../src/services/providers/providerUsability.ts')
  const usabilityReads = {
    anthropicApiKey: () => null, anthropicSubscriber: () => true, anthropicLimitStatus: () => 'rejected' as const, anthropicLimitObservation: () => seen,
    gptSeat: () => ({ state: 'ready' as const }), zaiKeyPresent: () => false, openaiLimitWindow: () => ({ state: 'limited' as const }),
    carryWords: (lane: string) => lane === 'openai' ? 'on credits · 62,500 left' : lane === 'anthropic' ? 'extra usage off — nothing carries requests until the reset' : undefined,
  }
  const map = usability.resolveProviderUsability(usabilityReads as never)
  check("the usability blocker carries them: 'the openai usage window is reached — resets per /usage · on credits · 62,500 left'", map.openai.limitBlocker === 'the openai usage window is reached — resets per /usage · on credits · 62,500 left', map.openai.limitBlocker)
  check("…and the Anthropic lane's blocker too", (map.anthropic.limitBlocker ?? '').includes(' — resets at ') && (map.anthropic.limitBlocker ?? '').endsWith(' · extra usage off — nothing carries requests until the reset'), map.anthropic.limitBlocker)
  const bare = usability.resolveProviderUsability({ ...usabilityReads, carryWords: undefined } as never)
  check('a read bundle without the carry read keeps the blockers as they were', bare.openai.limitBlocker === 'the openai usage window is reached — resets per /usage' && !(bare.anthropic.limitBlocker ?? '').includes(' · '), bare.openai.limitBlocker)
  const delegated = usability.delegationDispatchBlocker('openai', map)
  check('a delegated dispatch proceeds while the reading still names credits', delegated === null && map.openai.usable && map.openai.limitBlocker?.includes('on credits') === true, delegated ?? '(null)')

  const rail = src('src/utils/cockpit/helmTelemetryModel.ts')
  check("the rail paints the compact carry words under its reached line through the one composer, and the '100% · …' row without a wall", rail.includes("usageCarryWords(usage.carry, readNow, 'compact')") && rail.includes("reached === 'wall' ? carry : `100% · ${carry}`") && rail.includes('usageWindowReached(usage, readNow)'))
  const tab = src('src/components/Settings/Usage.tsx')
  check('the /usage tab appends the carry words to its reached sentences and paints the 100% line under every family\'s meters', tab.includes('toLocaleString()}{carryTail(owner)}.') && tab.includes('toLocaleTimeString()}${carryTail(usage)}.') && (tab.match(/<FullWindowLine usage=/g) ?? []).length >= 4 && tab.includes('A usage window reads 100%${carryTail(usage)}.'))
  const slotCard = src('src/components/SlotOfferCard.tsx')
  const composer = src('src/components/PromptInput/useComposerModelDoors.tsx')
  check('the slot offer card carries a carry line under its reached sentence, handed the owner\'s words by the composer', slotCard.includes('{GLYPH.dot} {carryWords}') && composer.includes('carryWords: usageCarryWords(usageForProvider(family).carry) ?? null') && composer.includes('carryWords={offer.carryWords}'))
  check('the handoff notice appends them after its reset', composer.includes("window is reached${resetText !== null ? ` · resets ${resetText}` : ''}${homeCarry !== undefined ? ` · ${homeCarry}` : ''}"))
  const capCard = src('src/components/CapOfferCard.tsx')
  check('the cross-family offer card carries a carry line under its reached sentence on a handoff, never on the way home', capCard.includes('{!home && carryWords ? (') && capCard.includes('{GLYPH.dot} {carryWords}') && composer.includes("carryWords={offer.direction === 'handoff' ? (usageCarryWords(usageForProvider(offer.homeRoute).carry) ?? null) : null}"))
  const refusalSrc = src('src/services/providers/anthropicRefusal.ts')
  check('the standing Anthropic refusal reads the owner\'s carry words', refusalSrc.includes('anthropicWindowWords(seen, anthropicCarryWords())') && refusalSrc.includes('usageCarryWords(anthropicExtraUsageCarry(limits !== undefined ? { anthropicLimits: () => limits } : undefined))'))
  const usabilitySrc = src('src/services/providers/providerUsability.ts')
  check('the live usability bundle reads them from the owner, only for a limited lane', usabilitySrc.includes('usageCarryWords(usageForProvider(lane).carry)') && usabilitySrc.includes("reads.carryWords?.(lane.provider)") && usabilitySrc.includes("if (window?.state !== 'limited' || lane.credential === 'none') return lane") && usabilitySrc.indexOf("reads.carryWords?.(lane.provider)") > usabilitySrc.indexOf("if (window?.state !== 'limited' || lane.credential === 'none') return lane"))
  const openaiWall = src('src/services/providers/openai/openaiCallModel.ts')
  check('the OpenAI wall row carries them after the wire\'s words', openaiWall.includes("usageCarryWords(usageForProvider('openai').carry)") && openaiWall.includes('— ${outcome.fault.message}${carryClause}. GPT work on this source pauses'))
  const strip = src('src/services/providers/limitWarning.ts')
  check('the strip warning appends them only at 100%', strip.includes('if (facts === null || facts.pct < 100) return facts') && strip.includes('text: `${facts.view.text} · ${carry}`'))
  const health = src('src/utils/healthReport.ts')
  check('the health row rides the summary words (which now carry them) and the standing refusal words', health.includes('owner.usageSummaryWords(owner.usageForProvider(presence.id))') && health.includes('standingWindowWords(presence.id)'))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-truth-meters${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
