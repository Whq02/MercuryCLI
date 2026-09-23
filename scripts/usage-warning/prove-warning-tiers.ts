import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { LimitWarningReads } from '../../src/services/providers/limitWarning.ts'

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
