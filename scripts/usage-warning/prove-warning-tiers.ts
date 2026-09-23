import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { LimitWarningReads, ProviderLimitWarningView } from '../../src/services/providers/limitWarning.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const warnings = await import('../../src/services/providers/limitWarning.ts')
const { decideCapAction, observedFamilyWindow } = await import('../../src/services/capFailover.ts')

const reset = Math.floor(Date.now() / 1000) + 604800
const entry = { id: 'fixture', provider: 'anthropic', kind: 'oauth', label: 'fixture', custodian: 'anthropic-slots' } as const
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
    assert.equal(facts?.tier ?? null, pct < 80 || pct >= 100 ? null : pct < 90 ? 80 : 90)
    const fact = observedFamilyWindow('anthropic', {
      now: () => (reset - 604800) * 1000,
      anthropic: () => ({ status: 'allowed', observed: true }),
      anthropicWindows: () => [window(pool ? 36 : pct)],
      anthropicPools: () => pool ? [window(pct, 'seven_day_fable', 'Fable')] : [],
    }, { model: 'fable' })
    assert.equal(fact.state, pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'allowed')
    assert.equal(fact.warningTier ?? null, pct < 80 || pct >= 100 ? null : pct < 90 ? 80 : 90)
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
    assert.equal(card.state, pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'allowed')
    assert.equal(facts?.tier ?? null, pct < 80 || pct >= 100 ? null : pct < 90 ? 80 : 90)
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
for (const pct of [79, 80, 85, 90, 95, 85, 90]) {
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
