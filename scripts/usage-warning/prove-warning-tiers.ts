import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { LimitWarningReads, ProviderLimitWarningView } from '../../src/services/providers/limitWarning.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const warnings = await import('../../src/services/providers/limitWarning.ts')
const { decideCapAction, observedFamilyWindow } = await import('../../src/services/capFailover.ts')
const tiers = await import('../../src/services/providers/usageTiers.ts')
assert.equal(warnings.FIRST_WARNING_PCT, tiers.FIRST_WARNING_PCT)
assert.equal(warnings.SECOND_WARNING_PCT, tiers.SECOND_WARNING_PCT)
assert.equal(warnings.APPROACHING_LIMIT_PCT, tiers.FIRST_WARNING_PCT)
assert.equal(warnings.usageWarningTier, tiers.usageWarningTier)
assert.equal(warnings.usageWindowState, tiers.usageWindowState)
assert.ok(!/\b(?:import|require)\b/.test(readFileSync(new URL('../../src/services/providers/usageTiers.ts', import.meta.url), 'utf8')))

const reset = Math.floor(Date.now() / 1000) + 604800
const entry = { id: 'fixture', provider: 'anthropic', kind: 'subscription-oauth', label: 'fixture', custodian: 'anthropic-slots' } as const
const window = (pct: number, key = '7d', label = key) => ({ key, label, state: 'live' as const, usedPct: pct, resetsAtMs: reset * 1000 })
const limits = { status: 'allowed' as const, isUsingOverage: false, unifiedRateLimitFallbackAvailable: false }
const reads = (pct: number, pool = false): LimitWarningReads => ({
  route: () => 'anthropic',
  activeEntry: () => entry,
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  anthropicPlan: () => 'max',
  anthropicLimits: () => limits,
  anthropicWindows: () => ({
    fiveHour: { key: '5h', state: 'live', usedPct: 12, resetsAtMs: reset * 1000 },
    sevenDay: { key: '7d', state: 'live', usedPct: pool ? 36 : pct, resetsAtMs: reset * 1000 },
  }),
  anthropicPoolWindows: () => pool ? [window(pct, 'seven_day_fable', 'Fable')] : [],
})

console.log('RED on the base: 79% warns and a warning offers a handoff; the two percentage tiers are absent')
for (const pool of [false, true]) {
  for (const pct of [79, 80, 85, 90, 95, 100]) {
    const facts = warnings.providerLimitWarningFacts({ model: 'fable', reads: reads(pct, pool) })
    assert.equal(facts?.tier ?? null, pct < 80 ? null : pct < 90 ? 80 : 90)
    const fact = observedFamilyWindow('anthropic', {
      now: () => (reset - 604800) * 1000,
      anthropic: () => ({ status: 'allowed', observed: true }),
      anthropicWindows: () => [window(pool ? 36 : pct)],
      anthropicPools: () => pool ? [window(pct, 'seven_day_fable', 'Fable')] : [],
    }, { model: 'fable' })
    assert.equal(fact.state, pct >= 80 ? 'warning' : 'allowed')
    assert.equal(fact.warningTier ?? null, pct < 80 ? null : pct < 90 ? 80 : 90)
    if (facts) assert.match(facts.view.text, new RegExp(`^Anthropic: ${pct}% of the ${pool ? 'Fable' : 'weekly'} limit used · resets `))
  }
}
for (const posture of ['off', 'offer', 'auto'] as const) {
  for (const state of ['warning', 'allowed_warning'] as const) assert.equal(decideCapAction(posture, state).kind, 'none')
  assert.equal(decideCapAction(posture, 'rejected').kind, posture === 'off' ? 'none' : posture === 'auto' ? 'auto-handoff' : 'offer')
}

const { getUsageLimitNoticeAttachment } = await import('../../src/utils/attachments/sessionContext.ts')
const context = { options: { mainLoopModel: 'fable' } } as Parameters<typeof getUsageLimitNoticeAttachment>[0]
const messages: unknown[] = []
for (const pct of [79, 80, 85, 90, 95]) {
  const notices = getUsageLimitNoticeAttachment(context, messages, reads(pct))
  assert.equal(notices.length, pct === 80 || pct === 90 ? 1 : 0)
  messages.push(...notices.map(attachment => ({ type: 'attachment', attachment })))
}
const first = warnings.usageWarningNoticeText('Anthropic: 80% of the weekly limit used', 80)
assert.equal(first, 'Usage limit near — Anthropic: 80% of the weekly limit used. The provider stops this session only when the window is used up.')
assert.equal(warnings.usageWarningNoticeText('Anthropic: 90% of the weekly limit used', 90), 'Usage limit near — Anthropic: 90% of the weekly limit used. The provider stops this session only when the window is used up. Keep the work resumable: finish the step in hand; commit what is done and write down where it stands.')
const attachment = readFileSync(new URL('../../src/utils/messages/attachmentText.ts', import.meta.url), 'utf8')
assert.match(attachment, /usageWarningNoticeText\(attachment\.text, attachment\.pct\)/)
console.log('PASS warning tiers, words-only postures and one context notice per tier')

console.log('RED on the base: the bare 36% latch beats the quiet meter and the time-relative table remains')
const { computeNewLimitsFromHeaders } = await import('../../src/services/claudeAiLimits.ts')
for (const pct of [36, 81]) {
  const header = {
    ...limits,
    status: 'allowed_warning' as const,
    rateLimitType: 'seven_day' as const,
    utilization: pct / 100,
    resetsAt: reset,
  }
  const facts = warnings.providerLimitWarningFacts({ model: 'fable', reads: { ...reads(pct), anthropicLimits: () => header } })
  const card = observedFamilyWindow('anthropic', {
    anthropic: () => ({ status: header.status, observed: true, usedPct: pct, resetsAtMs: reset * 1000, windowName: 'weekly limit' }),
    anthropicWindows: () => [window(pct)],
    anthropicPools: () => [],
  }, { model: 'fable' })
  assert.equal(card.state, pct < 80 ? 'allowed' : 'warning')
  assert.equal(facts !== null, card.state === 'warning')
  assert.equal(computeNewLimitsFromHeaders(new Headers({
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-7d-utilization': String(pct / 100),
    'anthropic-ratelimit-unified-7d-reset': String(reset),
    'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.25',
  })).status, pct < 80 ? 'allowed' : 'allowed_warning')
}
assert.equal(computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-reset': String(reset),
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
})).status, 'allowed')
const decoder = readFileSync(new URL('../../src/services/claudeAiLimits.ts', import.meta.url), 'utf8')
assert.ok(!decoder.includes('TIME_RELATIVE_CONFIGS') && !decoder.includes('elapsedFraction'))
console.log('PASS the card and strip follow the number; a bare warning is quiet')

console.log('RED on the base: Kimi and OpenRouter percentages have no card arm')
const usage = await import('../../src/services/providers/providerUsage.ts')
for (const family of ['openai', 'moonshot', 'openrouter'] as const) {
  for (const pct of [79, 80, 85, 90, 95, 100]) {
    const familyReads: LimitWarningReads = {
      route: () => family,
      spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
      activeEntry: () => ({ ...entry, provider: 'openai', custodian: 'openai-accounts' }),
      openaiObserved: () => ({ secondary: { usedPct: pct, windowMinutes: 10080, resetsAtMs: reset * 1000, observedAtMs: Date.now() } }),
      openaiLimited: () => ({ state: 'clear' }),
      moonshotAccount: () => ({ kind: 'kimi-oauth' }),
      kimiManagedUsage: () => ({ observedAtMs: Date.now(), windows: [{ windowMinutes: 300, used: pct, limit: 100, resetsAtMs: reset * 1000 }] }),
      openrouterKeyPresent: () => true,
      openrouterObserved: () => ({ usage: { limit: 100, limitRemaining: 100 - pct, observedAtMs: Date.now() } }),
      openrouterLimited: () => ({ state: 'clear' }),
    }
    const facts = warnings.providerLimitWarningFacts({ model: 'fixture', reads: familyReads })
    const windows = usage.usageForProvider(family, familyReads).windows
    const card = observedFamilyWindow(family, {
      openaiActiveSource: () => 'chatgpt-subscription',
      openaiWall: () => null,
      openaiBands: () => windows.map(w => ({ usedPct: w.usedPct!, resetsAtMs: w.resetsAtMs, windowName: usage.usageWindowWord(w) })),
      percentageWindows: () => windows,
      openrouterWall: () => null,
      laneBilling: () => ({ state: 'clear' }),
    })
    assert.equal(card.state, pct >= 80 ? 'warning' : 'allowed')
    assert.equal(facts?.tier ?? null, pct < 80 ? null : pct < 90 ? 80 : 90)
    if (facts) {
      assert.equal(card.warningTier, facts.tier)
      assert.equal(card.windowName, facts.windowName)
      assert.equal(card.usedPct, facts.pct)
    }
  }
}
for (const family of ['moonshot', 'openrouter'] as const) {
  const familyReads: LimitWarningReads = {
    route: () => family,
    spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
    moonshotAccount: () => ({ kind: 'api-key' }),
    moonshotBalance: () => null,
    openrouterKeyPresent: () => true,
    openrouterObserved: () => ({ usage: null }),
    openrouterLimited: () => ({ state: 'clear' }),
  }
  assert.equal(warnings.providerLimitWarningFacts({ model: 'fixture', reads: familyReads }), null)
  assert.equal(observedFamilyWindow(family, { percentageWindows: () => [], openrouterWall: () => null, laneBilling: () => ({ state: 'clear' }) }).state, 'unknown')
}
console.log('PASS every percentage family shares the tiers and a source without percentages stays quiet')

console.log('RED on the base: changing the percentage text re-notifies within a tier')
const seen = new Set<string>()
const emitted: ProviderLimitWarningView[] = []
for (const pct of [79, 80, 85, 90, 95, 100, 85, 90]) {
  const warning = warnings.providerLimitWarning({ model: 'fable', reads: reads(pct) })
  if (warnings.takeUsageWarning(seen, warning)) emitted.push(warning!)
}
assert.equal(emitted.length, 2)
assert.match(emitted[0]!.text, /80%/)
assert.match(emitted[1]!.text, /90%/)
assert.notEqual(emitted[0]!.key, emitted[1]!.key)
const hook = readFileSync(new URL('../../src/hooks/notifs/useRateLimitWarningNotification.tsx', import.meta.url), 'utf8')
assert.match(hook, /takeUsageWarning\(warningKeysRef\.current, warning\)/)
assert.match(hook, /key: `\$\{WARNING_KEY\}\|\$\{usageWarningEmissionKey\(warning\)\}`/)
assert.ok(!hook.includes('warning.text === lastWarningRef.current'))
console.log('PASS exactly two strip notifications, with crossing text and distinct queue keys')

const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/services/engine-connector/seatWire.ts')
const relayed = sessionFactsFromWire(sessionFactsToWire({
  model: { effective: 'fixture' },
  usage: { totalCostUSD: 0, limitWarning: emitted[1] },
  skills: [], mcp: [], permissionMode: 'flow', workspace: {}, queue: [],
} as never))
assert.equal((relayed?.usage.limitWarning as ProviderLimitWarningView | null)?.key, emitted[1]!.key)
console.log('PASS the tier key survives the existing facts codec')

console.log('RED on the base: /mock-limits warning-7d 80 is an unknown scenario')
process.env.MERCURY_MOCK_LIMITS = '1'
const mockCommand = await import('../../src/commands/mock-limits/mock-limits.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
let mockReset: string | undefined
for (const pct of [79, 80, 85, 90, 100]) {
  const result = await mockCommand.call(`warning-7d ${pct}`)
  assert.ok(result.type === 'text' && !result.value.includes('Unknown scenario'))
  const headers = mock.getMockHeaders()!
  assert.equal(Number(headers['anthropic-ratelimit-unified-7d-utilization']) * 100, pct)
  const resetNow = headers['anthropic-ratelimit-unified-7d-reset']
  if (mockReset !== undefined) assert.equal(resetNow, mockReset)
  mockReset = resetNow
}
const beforeInvalid = mock.getMockHeaders()
for (const invalid of ['-1', '101', 'NaN', '80 extra']) {
  const result = await mockCommand.call(`warning-7d ${invalid}`)
  assert.ok(result.type === 'text' && result.value.includes('0–100'))
  assert.deepEqual(mock.getMockHeaders(), beforeInvalid)
}
mock.setMockRateLimitScenario('clear')
delete process.env.MERCURY_MOCK_LIMITS
console.log('PASS the mock road reaches each tier, keeps its window identity and refuses invalid inputs')
const scenes = readFileSync(new URL('../ui/renderScenarios.ts', import.meta.url), 'utf8')
assert.ok(scenes.includes("name === 'cap-warning-strip'"))
assert.ok(scenes.includes('warning-7d 80') && scenes.includes('warning-7d 90'))

console.log('RED on the base: a reset band is live on the panel but absent on the card; a weekly wall reads the primary reset')
const { capUsageWords } = await import('../../src/services/capFailover.ts')
const { usageSourceWords } = await import('../../src/services/providers/usageFreshness.ts')
const now = Date.now()
const staleReads: LimitWarningReads = {
  route: () => 'openai', activeEntry: () => ({ ...entry, provider: 'openai', custodian: 'openai-accounts' }),
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  openaiLimited: () => ({ state: 'clear' }),
  openaiObserved: () => ({ secondary: { usedPct: 91, windowMinutes: 10080, resetsAtMs: now - 1000, observedAtMs: now - 60000 } }),
}
const staleWindows = usage.openaiObservedWindowViews(staleReads)
assert.equal(staleWindows[0]!.state, 'live')
assert.ok(usage.usageViewIsStale(staleWindows[0]!, now))
const staleBands = staleWindows.map(w => ({ ...w, usedPct: w.usedPct!, windowName: usage.usageWindowWord(w) }))
const staleCard = observedFamilyWindow('openai', {
  now: () => now, openaiActiveSource: () => 'chatgpt-subscription', openaiWall: () => null,
  openaiBands: () => staleBands, laneBilling: () => ({ state: 'clear' }),
})
assert.equal(staleCard.state, 'unknown')
assert.equal(capUsageWords(staleCard), usageSourceWords(staleWindows[0]!, now))
assert.match(capUsageWords(staleCard), /stale · last read/)
assert.equal(warnings.providerLimitWarningFacts({ model: 'fixture', reads: staleReads }), null)
const wallCard = observedFamilyWindow('openai', {
  now: () => now, openaiActiveSource: () => 'chatgpt-subscription',
  openaiWall: () => ({ resetsAtMs: now + 604800000 }),
  openaiBands: () => [{ usedPct: 100, resetsAtMs: now + 604800000, windowName: 'weekly window' }, { usedPct: 20, resetsAtMs: now + 3600000, windowName: '5h window' }],
})
assert.equal(wallCard.windowName, 'weekly window')
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.ts')
const stated = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 604800, plan_type: 'prolite' } }, new Headers({ 'x-codex-primary-reset-after-seconds': '3600' }))
assert.equal(stated.code, 'openai-usage_limit_reached')
assert.equal(stated.message, 'The usage limit has been reached (resets in ~7.0 days · plan: prolite)')
const weekly = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'Weekly usage limit reached', plan_type: 'prolite' } }, new Headers({
  'x-codex-primary-reset-after-seconds': '3600',
  'x-codex-primary-window-minutes': '300',
  'x-codex-secondary-reset-after-seconds': '604800',
  'x-codex-secondary-window-minutes': '10080',
}))
assert.ok(weekly.message.includes('x-codex-secondary-reset-after-seconds: 604800') && weekly.message.includes('plan: prolite'))
assert.ok((weekly.resetsAtMs ?? 0) >= now + 604800000)
const cappedSecondary = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }, new Headers({
  'x-codex-primary-used-percent': '32', 'x-codex-primary-reset-after-seconds': '3600',
  'x-codex-secondary-used-percent': '100', 'x-codex-secondary-reset-after-seconds': '604800',
}))
assert.ok(cappedSecondary.message.includes('x-codex-secondary-reset-after-seconds: 604800'))
console.log('PASS one stale word on both surfaces and reset facts from the body or matching window')

const spendText = 'Anthropic says this account is close to its extra usage spending limit'
assert.equal(warnings.usageWarningNoticeText(spendText, 0), `Usage limit near — ${spendText}. The provider stops this session when the window is used up. Finish the step in hand, commit what is done, and write down where the work stands before the stop; start nothing that cannot be saved in time.`)
const unlabelled = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'Limit reached' } }, new Headers({ 'x-codex-primary-reset-after-seconds': '3600' }))
assert.ok(unlabelled.message.includes('x-codex-primary-reset-after-seconds: 3600'))
const ambiguous = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'Limit reached' } }, new Headers({ 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-secondary-reset-after-seconds': '604800' }))
assert.equal(ambiguous.resetsAtMs, undefined)
assert.equal(ambiguous.message, 'Limit reached')

console.log('Compatibility: the separate overage signal never becomes a percentage wall')
const overageReset = String(Math.floor(Date.now() / 1000) + 60)
const overage = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-overage-surpassed-threshold': '0.9',
  'anthropic-ratelimit-unified-overage-utilization': '1',
  'anthropic-ratelimit-unified-overage-reset': overageReset,
}))
assert.equal(overage.status, 'allowed_warning')
assert.equal(overage.rateLimitType, 'overage')
assert.equal(overage.utilization, 1)
assert.equal(overage.resetsAt, Number(overageReset))
const overageWithoutPercent = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-overage-surpassed-threshold': '0.9',
}))
assert.equal(overageWithoutPercent.utilization, undefined)
assert.equal(overageWithoutPercent.status, 'allowed_warning')
const separateSignals = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.8',
  'anthropic-ratelimit-unified-5h-utilization': '0.85',
  'anthropic-ratelimit-unified-overage-surpassed-threshold': '0.9',
  'anthropic-ratelimit-unified-overage-utilization': '1',
}))
assert.equal(separateSignals.status, 'allowed_warning')
assert.equal(separateSignals.rateLimitType, 'five_hour')
const cardSource = readFileSync(new URL('../../src/services/capFailover.ts', import.meta.url), 'utf8')
assert.ok(cardSource.includes("current.rateLimitType !== 'overage' && current.utilization !== undefined"))
console.log('PASS the overage decoder keeps its old verdict and does not manufacture a window cap')

const expiredOverage = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-overage-surpassed-threshold': '0.9',
  'anthropic-ratelimit-unified-overage-utilization': '1',
  'anthropic-ratelimit-unified-overage-reset': String(Math.floor(Date.now() / 1000) - 60),
}))
assert.equal(expiredOverage.status, 'allowed')
const fullButAllowed = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '1',
  'anthropic-ratelimit-unified-7d-reset': String(reset),
}))
assert.equal(fullButAllowed.status, 'allowed_warning')
const wireRejects = computeNewLimitsFromHeaders(new Headers({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-7d-utilization': '0.36',
  'anthropic-ratelimit-unified-reset': String(reset),
}))
assert.equal(wireRejects.status, 'rejected')
console.log('PASS percentages through 100 stay words only; the wire alone rejects; expired warning resets are quiet')

const expired = Math.floor(Date.now() / 1000) - 60
const mixedReads = {
  ...reads(80),
  anthropicWindows: () => ({
    fiveHour: { key: '5h' as const, state: 'live' as const, usedPct: 100, resetsAtMs: expired * 1000 },
    sevenDay: { key: '7d' as const, state: 'live' as const, usedPct: 80, resetsAtMs: reset * 1000 },
  }),
  anthropicLimits: () => ({ ...limits, status: 'rejected' as const, utilization: 1, rateLimitType: 'five_hour' as const, resetsAt: expired }),
}
const mixedFact = warnings.providerLimitWarningFacts({ model: 'fable', reads: mixedReads })
const mixedCard = observedFamilyWindow('anthropic', {
  anthropic: () => ({ status: 'rejected', observed: true, usedPct: 100, resetsAtMs: expired * 1000 }),
  anthropicWindows: () => [window(100, '5h')].map(w => ({ ...w, resetsAtMs: expired * 1000 })).concat([window(80)]),
  anthropicPools: () => [],
}, { model: 'fable' })
assert.equal(mixedFact?.pct, 80)
assert.equal(mixedCard.state, 'warning')
assert.equal(mixedCard.usedPct, 80)
assert.equal(mixedCard.windowName, mixedFact?.windowName)
console.log('PASS an expired high band cannot hide a fresh lower band on either warning reader')
const explicitOpenaiWall = warnings.providerLimitWarningFacts({ model: 'fixture', reads: { ...staleReads,
  openaiObserved: () => ({ secondary: { usedPct: 100, windowMinutes: 10080, resetsAtMs: reset * 1000, observedAtMs: Date.now() } }),
  openaiLimited: () => ({ state: 'limited', resetsAtMs: reset * 1000, observedAtMs: Date.now() }),
} })
assert.equal(explicitOpenaiWall, null)
