#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnthropicLimits } from '../../src/models/roads/anthropic/anthropicLimits.ts'
import type { LimitWarningReads } from '../../src/models/roads/limitWarning.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cap-offer-rule-'))
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const cap = await import('../../src/models/roads/capFailover.ts')
const tiers = await import('../../src/models/roads/usageTiers.ts')
const limits = await import('../../src/models/roads/anthropic/anthropicLimits.ts')
const messages = await import('../../src/models/roads/anthropic/rateLimitMessages.ts')
const warnings = await import('../../src/models/roads/limitWarning.ts')

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
const latchAt = (pct: number): AnthropicLimits => ({
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
const stripReads = (pct: number, pool: number, header: AnthropicLimits): LimitWarningReads => ({
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
  check("the decoder demotes a 36% allowed_warning to 'allowed' (the latch carries the tier floor)", decoded.status === 'allowed', `${decoded.status} — computeNewLimitsFromHeaders in src/models/roads/anthropic/anthropicLimits.ts must demote an allowed_warning below the first warning tier to allowed`)
  const card = cardAt(36, 46)
  check("the card resolver reads the binding pool at 46% as 'allowed' with no tier", card.state === 'allowed' && card.warningTier === undefined && card.usedPct === 46, `${JSON.stringify(card)} — observedFamilyWindow in src/models/roads/capFailover.ts must read the binding pool (46%) as allowed with no tier`)
  check('no posture opens an offer from it', postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), `${offerWords(card.state)} — decideCapAction in src/models/roads/capFailover.ts must return none for every posture unless the state is rejected`)
  check("the row's usage words carry the number, never 'approaching'", cap.capUsageWords(card) === '46% of the Fable limit', `${cap.capUsageWords(card)} — see capUsageWords in src/models/roads/capFailover.ts`)
  check('the strip says nothing', warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(36, 46, latchAt(36)) }) === null, 'providerLimitWarningFacts in src/models/roads/limitWarning.ts must return null below the first warning tier')
}

section('§B 72%: below the first tier, the offer never opens and no surface warns')
{
  const decoded = limits.computeNewLimitsFromHeaders(wireAt(72))
  check("the decoder demotes a 72% allowed_warning to 'allowed'", decoded.status === 'allowed', `${decoded.status} — computeNewLimitsFromHeaders in src/models/roads/anthropic/anthropicLimits.ts must demote an allowed_warning below the first warning tier to allowed`)
  const card = cardAt(72, 46)
  check("the card resolver reads the weekly window at 72% as 'allowed' with no tier", card.state === 'allowed' && card.warningTier === undefined && card.usedPct === 72 && card.windowName === 'weekly limit', `${JSON.stringify(card)} — observedFamilyWindow in src/models/roads/capFailover.ts must read the weekly window at 72% as allowed with no tier`)
  check('no posture opens an offer from it', postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), `${offerWords(card.state)} — decideCapAction in src/models/roads/capFailover.ts must return none for every posture unless the state is rejected`)
  check('the strip says nothing', warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(72, 46, latchAt(72)) }) === null, 'providerLimitWarningFacts in src/models/roads/limitWarning.ts must return null below the first warning tier')
  check('the first tier is the one owner\'s number and sits above 72', tiers.FIRST_WARNING_PCT === cap.CAP_APPROACHING_PCT && cap.CAP_APPROACHING_PCT > 72 && tiers.SECOND_WARNING_PCT > tiers.FIRST_WARNING_PCT, `FIRST_WARNING_PCT=${tiers.FIRST_WARNING_PCT} CAP_APPROACHING_PCT=${cap.CAP_APPROACHING_PCT} SECOND_WARNING_PCT=${tiers.SECOND_WARNING_PCT} — CAP_APPROACHING_PCT in src/models/roads/capFailover.ts must equal FIRST_WARNING_PCT in src/models/roads/usageTiers.ts, above 72 and below SECOND_WARNING_PCT`)
}

section('§C 80% and 90%: words only, on every surface, at the same number — still no offer')
{
  for (const [pct, tier] of [[80, tiers.FIRST_WARNING_PCT], [90, tiers.SECOND_WARNING_PCT]] as const) {
    const decoded = limits.computeNewLimitsFromHeaders(wireAt(pct))
    check(`${pct}%: the decoder keeps the latch`, decoded.status === 'allowed_warning' && decoded.utilization === pct / 100, `${JSON.stringify(decoded)} — computeNewLimitsFromHeaders in src/models/roads/anthropic/anthropicLimits.ts must keep allowed_warning and the utilization at or above the first tier`)
    const card = cardAt(pct, 46)
    check(`${pct}%: the card resolver reads 'warning' at tier ${tier}, named as the wire named it`, card.state === 'warning' && card.warningTier === tier && card.usedPct === pct && card.windowName === 'weekly limit', `${JSON.stringify(card)} — observedFamilyWindow in src/models/roads/capFailover.ts must read a warning at this tier`)
    check(`${pct}%: no posture opens an offer from a warning`, postures.every(posture => cap.decideCapAction(posture, card.state).kind === 'none'), `${offerWords(card.state)} — decideCapAction in src/models/roads/capFailover.ts must return none for a warning in every posture`)
    check(`${pct}%: the row's usage words carry the number`, cap.capUsageWords(card) === `${pct}% of the weekly limit`, `${cap.capUsageWords(card)} — see capUsageWords in src/models/roads/capFailover.ts`)
    const facts = warnings.providerLimitWarningFacts({ model: MODEL, reads: stripReads(pct, 46, decoded) })
    check(`${pct}%: the strip warns at tier ${tier} in the one grammar`, facts?.tier === tier && facts.view.text.startsWith(`Anthropic: ${pct}% of the weekly limit used · resets `), `${facts?.view.text ?? 'null'} — see providerLimitWarningFacts in src/models/roads/limitWarning.ts`)
  }
}

section("§D the wire's refusal is the only offer; the way home is the only other trigger")
{
  const card = cardAt(36, 46, 'rejected')
  check("a rejected verdict reads 'rejected' whatever the meters say", card.state === 'rejected' && card.windowName === 'weekly limit', `${JSON.stringify(card)} — observedFamilyWindow in src/models/roads/capFailover.ts must read a rejected status as rejected`)
  const offer = cap.decideCapAction('offer', card.state)
  const auto = cap.decideCapAction('auto', card.state)
  check("posture offer presents the offer, trigger 'rejected'", offer.kind === 'offer' && offer.trigger === 'rejected', `${JSON.stringify(offer)} — decideCapAction in src/models/roads/capFailover.ts must present an offer on rejected under posture offer`)
  check("posture auto hands off unattended, trigger 'rejected'", auto.kind === 'auto-handoff' && auto.trigger === 'rejected', `${JSON.stringify(auto)} — decideCapAction in src/models/roads/capFailover.ts must hand off on rejected under posture auto`)
  check('posture off never moves', cap.decideCapAction('off', card.state).kind === 'none', 'decideCapAction in src/models/roads/capFailover.ts must return none under posture off')
  const home = cap.decideCapReturn('offer', { window: 'allowed', credentialUsable: true }, true)
  check("the way home is the 'reset' trigger", home.kind === 'offer' && home.trigger === 'reset', `${JSON.stringify(home)} — see decideCapReturn in src/models/roads/capFailover.ts`)
  check('every posture × every state: an action fires on rejected alone', postures.every(posture => states.every(state => (cap.decideCapAction(posture, state).kind !== 'none') === (state === 'rejected' && posture !== 'off'))), 'decideCapAction in src/models/roads/capFailover.ts must act on rejected alone and never under posture off')
}

section('§F RED on the base: the latch reader keeps a floor of its own and warns at 72%')
{
  const at72 = messages.getRateLimitMessage(latchAt(72), MODEL)
  check('getRateLimitMessage is quiet at 72% (the one tier floor, not a second number)', at72 === null, `${at72 === null ? '' : `got "${at72.message}"`} — getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts must return null below the first warning tier`)
  check('getRateLimitWarning is quiet at 72%', messages.getRateLimitWarning(latchAt(72), MODEL) === null, 'getRateLimitWarning in src/models/roads/anthropic/rateLimitMessages.ts must return null below the first warning tier')
  check('getRateLimitMessage is quiet at 36%', messages.getRateLimitMessage(latchAt(36), MODEL) === null, 'getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts must return null below the first warning tier')
  check('getRateLimitMessage is quiet at 79%', messages.getRateLimitMessage(latchAt(79), MODEL) === null, 'getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts must return null below the first warning tier')
  const at80 = messages.getRateLimitMessage(latchAt(80), MODEL)
  check('at 80% it speaks with the number', at80?.severity === 'warning' && /^Anthropic says this account has used 80% of its weekly limit · resets /.test(at80.message), `${at80?.message ?? 'null'} — see getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts`)
  const at90 = messages.getRateLimitMessage(latchAt(90), MODEL)
  check('at 90% it speaks with the number', at90?.severity === 'warning' && /^Anthropic says this account has used 90% of its weekly limit/.test(at90.message), `${at90?.message ?? 'null'} — see getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts`)
  const bare = messages.getRateLimitMessage({ ...latchAt(80), utilization: undefined }, MODEL)
  check("a latch with no percent speaks in the provider's own voice, never as the card's claim", bare?.severity === 'warning' && /^Anthropic says this account is approaching its weekly limit/.test(bare.message), `${bare?.message ?? 'null'} — see getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts`)
}

console.log(failures === 0 ? '\nPASS the cap offer rule: a refusal offers, a percentage warns in words at the one owner\'s tiers, the latch never reaches the card' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
