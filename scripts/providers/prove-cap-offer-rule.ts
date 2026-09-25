#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAILimits } from '../../src/services/claudeAiLimits.ts'
import type { LimitWarningReads } from '../../src/services/providers/limitWarning.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cap-offer-rule-'))
process.env.NODE_ENV = 'test'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const cap = await import('../../src/services/capFailover.ts')
const tiers = await import('../../src/services/providers/usageTiers.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const messages = await import('../../src/services/rateLimitMessages.ts')
const warnings = await import('../../src/services/providers/limitWarning.ts')

const MODEL = 'claude-fable-5-1'
const now = Date.now()
const reset = Math.floor(now / 1000) + 6 * 86400
const postures = ['off', 'offer', 'auto'] as const
const states = ['allowed', 'allowed_warning', 'warning', 'rejected', 'unknown'] as const
const view = (pct: number, key = '7d', label = key) => ({ key, label, state: 'live' as const, usedPct: pct, resetsAtMs: reset * 1000 })
const entry = { id: 'fixture', provider: 'anthropic', kind: 'subscription-oauth', label: 'fixture', custodian: 'anthropic-slots' } as const

const wireAt = (pct: number): Headers => new Headers({
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-reset': String(reset),
  'anthropic-ratelimit-unified-7d-utilization': String(pct / 100),
  'anthropic-ratelimit-unified-7d-reset': String(reset),
  'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.25',
})
const latchAt = (pct: number): ClaudeAILimits => ({
  status: 'allowed_warning',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  rateLimitType: 'seven_day',
  utilization: pct / 100,
  resetsAt: reset,
})
const cardAt = (pct: number, pool: number, status: 'allowed' | 'allowed_warning' | 'rejected' = 'allowed_warning') =>
  cap.observedFamilyWindow('anthropic', {
    now: () => now,
    anthropic: () => ({ status, observed: true, usedPct: pct, resetsAtMs: reset * 1000, windowName: 'weekly limit' }),
    anthropicWindows: () => [view(12, '5h'), view(pct)],
    anthropicPools: () => [view(pool, 'seven_day_fable', 'Fable')],
  }, { model: MODEL })
const stripReads = (pct: number, pool: number, header: ClaudeAILimits): LimitWarningReads => ({
  route: () => 'anthropic',
  activeEntry: () => entry,
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  anthropicPlan: () => 'max',
  anthropicLimits: () => header,
  anthropicWindows: () => ({
    fiveHour: { key: '5h', state: 'live', usedPct: 12, resetsAtMs: reset * 1000 },
    sevenDay: { key: '7d', state: 'live', usedPct: pct, resetsAtMs: reset * 1000 },
  }),
  anthropicPoolWindows: () => [view(pool, 'seven_day_fable', 'Fable')],
})
const offerWords = (state: (typeof states)[number]): string =>
  postures.map(posture => `${posture}:${cap.decideCapAction(posture, state).kind}`).join(' ')

console.log('============================================================')
console.log(' the cap offer rule — a percentage never offers; the wire latch never reaches the card')
console.log('============================================================')

section('§A the screen at 36% of the week with the wire latch raised: no offer, no approaching words')
{
  const decoded = limits.computeNewLimitsFromHeaders(wireAt(36))
  check("the decoder demotes a 36% allowed_warning to 'allowed' (the latch carries the tier floor)", decoded.status === 'allowed', decoded.status)
  const card = cardAt(36, 46)
  check("the card resolver reads the binding pool at 46% as 'allowed' with no tier", card.state === 'allowed' && card.warningTier === undefined && card.usedPct === 46, JSON.stringify(card))
  check('no posture opens an offer from it', postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), offerWords(card.state))
  check("the row's usage words carry the number, never 'approaching'", cap.capUsageWords(card) === '46% of the Fable limit', cap.capUsageWords(card))
  check('the strip says nothing', warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(36, 46, latchAt(36)) }) === null)
}

section('§B 72%: below the first tier, the offer never opens and no surface warns')
{
  const decoded = limits.computeNewLimitsFromHeaders(wireAt(72))
  check("the decoder demotes a 72% allowed_warning to 'allowed'", decoded.status === 'allowed', decoded.status)
  const card = cardAt(72, 46)
  check("the card resolver reads the weekly window at 72% as 'allowed' with no tier", card.state === 'allowed' && card.warningTier === undefined && card.usedPct === 72 && card.windowName === 'weekly limit', JSON.stringify(card))
  check('no posture opens an offer from it', postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), offerWords(card.state))
  check('the strip says nothing', warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(72, 46, latchAt(72)) }) === null)
  check('the first tier is the one owner\'s number and sits above 72', tiers.FIRST_WARNING_PCT === cap.CAP_APPROACHING_PCT && cap.CAP_APPROACHING_PCT > 72 && tiers.SECOND_WARNING_PCT > tiers.FIRST_WARNING_PCT)
}

section('§C 80% and 90%: words only, on every surface, at the same number — still no offer')
{
  for (const [pct, tier] of [[80, tiers.FIRST_WARNING_PCT], [90, tiers.SECOND_WARNING_PCT]] as const) {
    const decoded = limits.computeNewLimitsFromHeaders(wireAt(pct))
    check(`${pct}%: the decoder keeps the latch`, decoded.status === 'allowed_warning' && decoded.utilization === pct / 100, JSON.stringify(decoded))
    const card = cardAt(pct, 46)
    check(`${pct}%: the card resolver reads 'warning' at tier ${tier}, named as the wire named it`, card.state === 'warning' && card.warningTier === tier && card.usedPct === pct && card.windowName === 'weekly limit', JSON.stringify(card))
    check(`${pct}%: no posture opens an offer from a warning`, postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), offerWords(card.state))
    check(`${pct}%: the row's usage words carry the number`, cap.capUsageWords(card) === `${pct}% of the weekly limit`, cap.capUsageWords(card))
    const facts = warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(pct, 46, decoded) })
    check(`${pct}%: the strip warns at tier ${tier} in the one grammar`, facts?.tier === tier && facts.view.text.startsWith(`Anthropic: ${pct}% of the weekly limit used · resets `), facts?.view.text ?? 'null')
  }
}

section("§D the wire's refusal is the only offer; the way home is the only other trigger")
{
  const card = cardAt(36, 46, 'rejected')
  check("a rejected verdict reads 'rejected' whatever the meters say", card.state === 'rejected' && card.windowName === 'weekly limit', JSON.stringify(card))
  const offer = cap.decideCapAction('offer', card.state)
  const auto = cap.decideCapAction('auto', card.state)
  check("posture offer presents the offer, trigger 'rejected'", offer.kind === 'offer' && offer.trigger === 'rejected', JSON.stringify(offer))
  check("posture auto hands off unattended, trigger 'rejected'", auto.kind === 'auto-handoff' && auto.trigger === 'rejected', JSON.stringify(auto))
  check('posture off never moves', cap.decideCapAction('off', card.state).kind === 'none')
  const home = cap.decideCapReturn('offer', { window: 'allowed', credentialUsable: true }, true)
  check("the way home is the 'reset' trigger", home.kind === 'offer' && home.trigger === 'reset', JSON.stringify(home))
  check('every posture × every state: an action fires on rejected alone', postures.every(posture => states.every(state => (cap.decideCapAction(posture, state).kind !== 'none') === (state === 'rejected' && posture !== 'off'))))
}

section('§E RED on the base: the card can still be built for a warning, and keeps the arm that paints the untrue sentence')
{
  const failover = source('src/services/capFailover.ts')
  const typed = /trigger: 'rejected' \| 'reset'/.exec(failover)
  check("the offer's trigger type admits 'rejected' and 'reset' only (capFailover.ts CapAction)", typed !== null && !failover.includes("trigger: 'warning'"), failover.includes("trigger: 'warning' | 'rejected' | 'reset'") ? "found `trigger: 'warning' | 'rejected' | 'reset'`" : 'no rejected|reset trigger type')
  check('the module header no longer says a warning offers', !/warnings still OFFER|warning \(preemptive, clean-boundary\)/.test(failover))
  const card = source('src/components/CapOfferCard.tsx')
  const approaching = /`approaching the \$\{homeName\} \$\{windowNoun\}`/.exec(card)
  check("the card has no arm that paints 'approaching the <family> <window>'", approaching === null, approaching !== null ? `found ${approaching[0]}` : '')
  check("the card's trigger prop is 'rejected' | 'reset'", card.includes("trigger: 'rejected' | 'reset'") && !card.includes("trigger: 'warning' | 'rejected' | 'reset'"))
  check('the card still names a reached window and exhausted credits as the wire named them', card.includes('`the ${homeName} ${windowNoun} is reached — ${homeName} requests are refused until reset`') && card.includes('`the ${homeName} credits are exhausted — ${homeName} requests are refused until reset`'))
  const composer = source('src/components/PromptInput/PromptInput.tsx')
  check("the composer's offer state admits no 'warning' trigger", !composer.includes("trigger: 'warning' | 'rejected' | 'reset'"))
  check('the composer hands the card the decision\'s own trigger', composer.includes('trigger: action.trigger') && composer.includes('trigger={offer.trigger}'))
  const docs = source('docs/ENGINES.md')
  check('the docs state the rule', docs.includes('no percentage, even 100%, holds work, stops a turn or offers a handoff'))
}

section('§F RED on the base: the latch reader keeps a floor of its own and warns at 72%')
{
  const at72 = messages.getRateLimitMessage(latchAt(72), MODEL)
  check('getRateLimitMessage is quiet at 72% (the one tier floor, not a second number)', at72 === null, at72 === null ? '' : `got "${at72.message}"`)
  check('getRateLimitWarning is quiet at 72%', messages.getRateLimitWarning(latchAt(72), MODEL) === null)
  check('getRateLimitMessage is quiet at 36%', messages.getRateLimitMessage(latchAt(36), MODEL) === null)
  check('getRateLimitMessage is quiet at 79%', messages.getRateLimitMessage(latchAt(79), MODEL) === null)
  const at80 = messages.getRateLimitMessage(latchAt(80), MODEL)
  check('at 80% it speaks with the number', at80?.severity === 'warning' && /^Anthropic says this account has used 80% of its weekly limit · resets /.test(at80.message), at80?.message ?? 'null')
  const at90 = messages.getRateLimitMessage(latchAt(90), MODEL)
  check('at 90% it speaks with the number', at90?.severity === 'warning' && /^Anthropic says this account has used 90% of its weekly limit/.test(at90.message), at90?.message ?? 'null')
  const bare = messages.getRateLimitMessage({ ...latchAt(80), utilization: undefined }, MODEL)
  check("a latch with no percent speaks in the provider's own voice, never as the card's claim", bare?.severity === 'warning' && /^Anthropic says this account is approaching its weekly limit/.test(bare.message), bare?.message ?? 'null')
  const src = source('src/services/rateLimitMessages.ts')
  check('the reader carries no floor of its own', !src.includes('< 0.7') && src.includes('usageWarningTier('))
}

console.log(failures === 0 ? '\nPASS the cap offer rule: a refusal offers, a percentage warns in words at the one owner\'s tiers, the latch never reaches the card' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
