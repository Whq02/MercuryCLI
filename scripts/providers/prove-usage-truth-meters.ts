#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-usage-truth-meters.ts — every usage meter tells
//  the truth: the per-model weekly pools are visible on every surface, the
//  binding window is the model's own, every figure names its feed and age,
//  the api-key credits line reports a balance or says the provider reports
//  none, and nothing is ever a fabricated zero.
//
//  The sighting this closes: the first-party usage page showed three meters
//  (session 36% · all-models week 44% · the Fable week 87%) while the rail
//  and the tab painted only 5h and 7d — the reader parsed the pools and fed
//  them to the strip warning alone; a Sonnet session could be warned about
//  the Fable week; no meter said where its number came from or how old it
//  was; no key slot said what its credits were.
//
//   §1 the pools ride the active-source view, and every renderer folds them
//      (source pins: the rail, /deck, the band, the deck strip, the tab, the
//      doctor)
//   §2 the binding window per model: the pool of the model's OWN family,
//      never another's; the strip warning names it; a haiku id is capped by
//      the shared pair alone; the cap offer's accessor answers the same
//   §3 the freshness vocabulary: live ⇒ 'read N ago'; older than the
//      reader's horizon ⇒ 'stale · last read N ago'; a seed says seeded; an
//      unstamped record names its feed alone; the narrow stale tail
//   §4 the credits line per family: reported verbatim with feed + age
//      (OpenRouter's capped key, the DeepSeek and Moonshot balances), not
//      stated (an uncapped key), not read yet, or 'not reported by the
//      provider' (every lane with no balance road); subscriptions carry none
//   §5 never a fabricated zero: a pool the endpoint did not state is absent,
//      a null utilization is absent, a family with nothing has no windows
//   §6 reset instants in the operator's local clock
//   §7 the copy census: the vocabulary lives in one module; no surface
//      spells its own stamp
//   §8 the doctor row rides the owner's summary words
//
//  Hermetic: injected reads for every family; the first-party record is
//  exercised through its real fold seam with an explicit clock. No network.
//
//  Run:  ~/.bun/bin/bun run scripts/providers/prove-usage-truth-meters.ts
// ============================================================================
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
const limits = await import('../../src/services/claudeAiLimits.ts')
const { providerLimitWarning } = await import('../../src/services/providers/limitWarning.ts')
type Reads = NonNullable<Parameters<typeof owner.activeSourceUsage>[0]>['reads']

const NOW = 1_760_000_000_000
const MIN = 60_000
const HOUR = 3_600_000
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const subEntry = { id: 'fx-sub', provider: 'anthropic', kind: 'oauth', label: 'fixture subscription', custodian: 'anthropic-slots' } as const

/** The first-party subscription with the three pools the operator's page
 *  showed: session 36 · all-models week 44 · Fable 87 · Opus 61 · Sonnet 20. */
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

// ── §1 the pools ride the view; every renderer folds them ───────────────────
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

  const rail = src('src/components/HelmTelemetryRail.tsx')
  check('the rail folds the focused source\'s pools under its windows', rail.includes('usage.pools.filter(w => w.state === \'live\')'))
  check('…and every beside-account\'s pools under its own block', rail.includes('other.pools.filter(x => x.state === \'live\')'))
  check('the rail\'s meter tail turns stale (the read\'s age) before the countdown', rail.includes('usageStaleTail(w, now)') && rail.includes('meterTail(w, pool)'))
  const deck = src('src/components/Deck.tsx')
  check('/deck paints the pools beside the pair and one read line', deck.includes('[...usage.windows, ...usage.pools]') && deck.includes('usageSourceWords(freshest, now)'))
  const band = src('src/components/MercuryFrame.tsx')
  check('the frame band\'s second chip is the binding window', band.includes('usage.binding.window.key !== first.key') && band.includes('? usage.binding.window'))
  const strip = src('src/components/DeckPane.tsx')
  check('the deck strip\'s second chip is the binding window', strip.includes('sourceUsage.binding.window.key !== stripFirst.key'))
  const tab = src('src/components/Settings/Usage.tsx')
  check('the tab reads the pools through the owner\'s pool view, titled by label', tab.includes('anthropicPoolWindowViews()') && tab.includes('`Current week (${w.label})`'))
  check('the tab decodes the fetch response nowhere (one owner, one decode)', !tab.includes('data.seven_day_') && !tab.includes('data.five_hour'))
  const doctor = src('src/utils/healthReport.ts')
  check('the doctor mounts one usage row per signed-in family from the owner', doctor.includes('id: `usage-${presence.id}`') && doctor.includes('owner.usageSummaryWords(owner.usageForProvider(presence.id))'))
  check('…in the AUTH section after the credential rows', doctor.includes('...providerAuthChecks(), ...providerUsageChecks()'))
}

// ── §2 the binding window per model ─────────────────────────────────────────
section('§2 the binding window is the model\'s own: its family\'s pool, the shared pair, never another family\'s week')
{
  const cases: Array<[string, string, string]> = [
    ['claude-fable-5-1', 'seven_day_fable', 'Fable limit'],
    ['claude-fable-5-1[1m]', 'seven_day_fable', 'Fable limit'],
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
  check('the pool claim for a model is the owner\'s one rule (fable · opus · sonnet · none)', limits.weeklyPoolClaimForModel('claude-fable-5-1') === 'seven_day_fable' && limits.weeklyPoolClaimForModel('claude-opus-5') === 'seven_day_opus' && limits.weeklyPoolClaimForModel('claude-sonnet-5') === 'seven_day_sonnet' && limits.weeklyPoolClaimForModel('claude-haiku-4-5') === undefined)
  // The strip warning names the binding window, and only when it binds.
  const fable = providerLimitWarning({ model: 'claude-fable-5-1', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Fable session is warned about the Fable week (87%)', /^Anthropic: 87% of Fable limit used · resets /.test(fable?.text ?? ''), fable?.text ?? '(null)')
  const sonnet = providerLimitWarning({ model: 'claude-sonnet-5', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Sonnet session is NOT warned about the Fable week (its own windows sit at 44 and 20)', sonnet === null, JSON.stringify(sonnet))
  const haiku = providerLimitWarning({ model: 'claude-haiku-4-5-20251001', reads: { ...subscriptionReads(), anthropicLimits: () => ({ status: 'allowed', unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }) } as never })
  check('a Haiku session is capped by the shared pair alone (no warning at 44)', haiku === null)
  // A first-party session with the pair binding harder than its pool.
  const pairBinds = owner.activeSourceUsage({
    model: 'claude-fable-5-1',
    reads: { ...subscriptionReads(), anthropicWindows: () => ({ fiveHour: { key: '5h', usedPct: 91, resetsAtMs: NOW + HOUR, state: 'live' }, sevenDay: { key: '7d', usedPct: 44, resetsAtMs: NOW + HOUR, state: 'live' } }) } as Reads,
  })
  check('when the session window binds harder than the pool, the session window is the binding one', pairBinds.binding?.window.key === '5h' && pairBinds.binding?.windowName === 'session limit')
  // Engine lanes: the binding window is the worst stated window, in the
  // family's own words.
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

// ── §3 the freshness vocabulary ─────────────────────────────────────────────
section('§3 feed + age: live reads say how old they are; stale reads say so; a seed says seeded')
{
  const w = fresh.usageSourceWords
  check("a fresh endpoint read: 'endpoint-fed · read 12 s ago'", w({ source: 'endpoint', observedAtMs: NOW - 12_000, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW) === 'endpoint-fed · read 12 s ago', w({ source: 'endpoint', observedAtMs: NOW - 12_000, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW))
  check("a header read three minutes old is live at the response horizon: 'header-fed · read 3 min ago'", w({ source: 'headers', observedAtMs: NOW - 3 * MIN }, NOW) === 'header-fed · read 3 min ago')
  check("a polled read past the poll TTL is STALE: 'endpoint-fed · stale · last read 1 min ago'", w({ source: 'endpoint', observedAtMs: NOW - 90_000 }, NOW) === 'endpoint-fed · stale · last read 1 min ago', w({ source: 'endpoint', observedAtMs: NOW - 90_000 }, NOW))
  check("a subscription read past its five-minute horizon is STALE: 'endpoint-fed · stale · last read 12 min ago'", w({ source: 'endpoint', observedAtMs: NOW - 12 * MIN, freshForMs: fresh.USAGE_RESPONSE_FRESH_MS }, NOW) === 'endpoint-fed · stale · last read 12 min ago')
  check("a day-old header read: 'header-fed · stale · last read 1 d ago'", w({ source: 'headers', observedAtMs: NOW - 25 * HOUR }, NOW) === 'header-fed · stale · last read 1 d ago')
  check("a seed says 'seeded' — a fixture never ages into a live read", w({ source: 'seed', observedAtMs: NOW - 10 * HOUR }, NOW) === 'seeded' && w({ source: 'seed' }, NOW) === 'seeded')
  check('an unstamped record names its feed alone', w({ source: 'endpoint' }, NOW) === 'endpoint-fed')
  check('nothing to say when neither feed nor stamp exists', w({}, NOW) === undefined)
  check("the narrow stale tail: '↻12m' while stale, nothing while live", fresh.usageStaleTail({ source: 'endpoint', observedAtMs: NOW - 12 * MIN }, NOW) === '↻12m' && fresh.usageStaleTail({ source: 'endpoint', observedAtMs: NOW - 12_000 }, NOW) === undefined)
  check('the age words: 12 s · 3 min · 2 h 5 min · 3 d', fresh.formatUsageAge(12_000) === '12 s' && fresh.formatUsageAge(3 * MIN) === '3 min' && fresh.formatUsageAge(2 * HOUR + 5 * MIN) === '2 h 5 min' && fresh.formatUsageAge(3 * 24 * HOUR) === '3 d')
  check('the one poll TTL is a minute, and every polling reader imports it', fresh.USAGE_POLL_TTL_MS === 60_000 && ['src/services/providers/openrouter/openrouterUsageState.ts', 'src/services/providers/deepseek/deepseekUsageState.ts', 'src/services/providers/moonshot/moonshotUsageState.ts'].every(f => src(f).includes('USAGE_POLL_TTL_MS')))
  // The record stamps: the fold marks every window of one observation
  // with the endpoint feed and the fold's clock; a header recompute marks
  // the header feed; the view carries both through.
  limits.resetLimitsForCredentialSwitch()
  const iso = new Date(NOW + HOUR).toISOString()
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: 36, resets_at: iso }, seven_day: { utilization: 44, resets_at: iso }, seven_day_fable: { utilization: 87, resets_at: iso } }, undefined, NOW - 30_000)
  const folded = owner.anthropicWindowViews()
  const pools = owner.anthropicPoolWindowViews()
  check('the folded pair names the endpoint feed and the fold\'s stamp', folded.every(v => v.source === 'endpoint' && v.observedAtMs === NOW - 30_000 && v.freshForMs === fresh.USAGE_RESPONSE_FRESH_MS), JSON.stringify(folded))
  check('the folded pool names the endpoint feed and the same stamp', pools.length === 1 && pools[0]?.source === 'endpoint' && pools[0]?.observedAtMs === NOW - 30_000)
  check("…so the words read 'endpoint-fed · read 30 s ago'", w(folded[0]!, NOW) === 'endpoint-fed · read 30 s ago')
  check("…and twelve minutes on, 'endpoint-fed · stale · last read 12 min ago'", w(folded[0]!, NOW + 12 * MIN - 30_000) === 'endpoint-fed · stale · last read 12 min ago')
  const stale = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads({ readAtMs: NOW - 12 * MIN }) })
  check('a stale view is stale by the one test every renderer uses', owner.usageViewIsStale(stale.windows[0]!, NOW) && owner.usageViewIsStale(stale.pools[0]!, NOW))
  limits.resetLimitsForCredentialSwitch()
}

// ── §4 the credits line ─────────────────────────────────────────────────────
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
  const sub = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads() })
  const kimi = owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'kimi-oauth' }), kimiManagedUsage: () => ({ observedAtMs: NOW, windows: [{ windowMinutes: 300, used: 1, limit: 10 }] }), spend: () => spend })
  const local = owner.usageForProvider('local', { localAccount: () => ({ kind: 'keyless', label: 'Ollama', serverCount: 1, modelCount: 2 }) as never, spend: () => spend })
  check('a subscription, a Kimi sign-in and a local server carry no credits line (windows or nothing are their meter)', sub.credits === undefined && kimi.credits === undefined && local.credits === undefined && line(sub) === undefined)
  const tab = src('src/components/Settings/Usage.tsx')
  check('every API-key slot on the tab carries the owner\'s credits line', (tab.match(/creditsLine: usageCreditsLine\(/g) ?? []).length >= 6 && tab.includes('{isActive && creditsLine !== undefined ? <Text dimColor>{creditsLine}</Text> : null}'))
  const rail = src('src/components/HelmTelemetryRail.tsx')
  check('the rail\'s api-key block carries the compact credits line', rail.includes("usageCreditsLine(usage.credits, now, 'compact')"))
  const deck = src('src/components/Deck.tsx')
  check('/deck\'s api-key block carries the credits row', deck.includes("padTo('credits', 11)") && deck.includes('usageCreditsWords(usage.credits, now)'))
}

// ── §5 never a fabricated zero ──────────────────────────────────────────────
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
  const rail = src('src/components/HelmTelemetryRail.tsx')
  const deck = src('src/components/Deck.tsx')
  check('the rail and /deck lead their unread state with the one spelling', rail.includes('${NO_USAGE_READ_WORDS} · fills after first reply') && deck.includes('{NO_USAGE_READ_WORDS} · fills after first reply'))
}

// ── §6 local reset instants ─────────────────────────────────────────────────
section("§6 reset instants in the operator's local clock")
{
  const at = NOW + 2 * HOUR + 10 * MIN
  const d = new Date(at)
  // The operator's clock, spelled from the Date API alone: a reset on
  // another day carries its weekday ('Thu 12:03'); today's carries none.
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

// ── §7 the copy census ──────────────────────────────────────────────────────
section('§7 one vocabulary: the feed + freshness words live in one module; no surface spells its own stamp')
{
  const vocabulary = ['endpoint-fed', 'header-fed', 'last read', 'seeded']
  const surfaces = [
    'src/services/providers/providerUsage.ts',
    'src/components/HelmTelemetryRail.tsx',
    'src/components/Deck.tsx',
    'src/components/DeckPane.tsx',
    'src/components/MercuryFrame.tsx',
    'src/components/Settings/Usage.tsx',
    'src/utils/healthReport.ts',
  ]
  const home = src('src/services/providers/usageFreshness.ts')
  check('the vocabulary is spelled in its one home', vocabulary.every(word => home.includes(`'${word}`) || home.includes(word)))
  for (const file of surfaces) {
    const text = src(file)
    // Comments may name the words; code strings never spell them.
    const code = text
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    check(`${file} spells no vocabulary word of its own`, vocabulary.every(word => !code.includes(`'${word}`) && !code.includes(`\`${word}`) && !code.includes(` ${word} `)), vocabulary.filter(word => code.includes(word)).join(','))
  }
  const tab = src('src/components/Settings/Usage.tsx')
  check("the tab's old per-surface stamps are gone ('observed HH:MM', 'live from the account source')", !tab.includes('observed ${new Date(') && !tab.includes('live from the account source') && !tab.includes('Balance (provider-stated)'))
  check('the tab captions every meter through the one composer', (tab.match(/usageSourceWords\(/g) ?? []).length >= 3)
  const words = owner.usageSummaryWords(owner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => ({ usage: { limit: 20, limitRemaining: 7.5, usage: 12.5, observedAtMs: NOW - 5_000 } as never }), openrouterLimited: () => ({ state: 'clear' }), spend: () => spend }), NOW)
  check('an engine summary speaks the same words as the first-party one', words.includes('endpoint-fed · read 5 s ago') && words.includes('credits: 7.50 remaining under the key cap'), words)
}

// ── §8 the doctor row ───────────────────────────────────────────────────────
section("§8 the doctor's usage row is the owner's summary — windows, pools, feed + age, credits")
{
  const view = owner.activeSourceUsage({ model: 'claude-fable-5-1', reads: subscriptionReads() })
  const words = owner.usageSummaryWords(view, NOW)
  check('the summary leads with the tier and walks the pair then the pools', words.startsWith('Claude Max · 5h 36%') && words.indexOf('7d 44%') < words.indexOf('Fable 87%') && words.includes('Opus 61%') && words.includes('Sonnet 20%'), words)
  check('…and names the feed and age once for the block', words.includes(' · endpoint-fed · read 10 s ago'), words)
  const key = owner.usageSummaryWords(owner.usageForProvider('zai', { zaiKeyPresent: () => true, spend: () => spend }), NOW)
  check('an api-key summary carries the tier, the absence and the credits line', key.startsWith('API billing · ') && key.includes('credits: not reported by the provider') && key.includes('Z.AI publishes no usage or balance endpoint'), key)
  const none = owner.usageSummaryWords(owner.usageForProvider('openrouter', { openrouterKeyPresent: () => false, spend: () => spend }), NOW)
  check("a signed-out family's summary is its why-not", none === 'not connected — /logins adds OpenRouter', none)
  const limited = owner.usageSummaryWords({ ...view, limited: { resetsAtMs: NOW + 30 * MIN } }, NOW)
  check('a reached limit rides the summary with its local reset', /limit reached · resets (?:[A-Z][a-z]{2} )?\d{2}:\d{2} \(in 30m\)$/.test(limited), limited)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-truth-meters${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
