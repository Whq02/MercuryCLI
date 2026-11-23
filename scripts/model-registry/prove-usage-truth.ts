#!/usr/bin/env bun
import { join } from 'node:path'
import {
  recordOpenaiRateHeaders,
  openaiObservedUsage,
  __resetOpenaiLimitStateForTest,
} from '../../src/models/roads/openai/openaiLimitState.js'
import {
  activeSourceUsage,
  openaiObservedWindowViews,
  openaiSubscriptionCredits,
  usageWindowLabel,
  type ActiveUsageReads,
} from '../../src/models/roads/providerUsage.js'
import type { WalletEntry } from '../../src/models/wallet/wallet.js'

const USAGE_SECTION_HINTS: Record<string, string> = {
  '1': 'change recordOpenaiRateHeaders in src/models/roads/openai/openaiLimitState.ts so it records only the bands and fields the x-codex headers state',
  '2': 'change usageWindowLabel in src/models/roads/provider-usage/shared.ts so the label follows the stated window length',
  '3': 'change activeSourceUsage, openaiObservedWindowViews or openaiSubscriptionCredits in src/models/roads/providerUsage.ts so the shape, label and windows follow the active source',
  '3b': 'change activeSourceUsage in src/models/roads/providerUsage.ts so the tier word derives from the active wallet entry and plan',
}
let usageFailureHint = ''
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = [detail, usageFailureHint ? `change: ${usageFailureHint}` : ''].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  usageFailureHint = USAGE_SECTION_HINTS[t.split(' ')[0] ?? ''] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


console.log('============================================================')
console.log(' USAGE-TRUTH — one live owner, two renderers, honest shapes')
console.log('============================================================')

section('1 · the x-codex header decode — only what the source stated')
{
  const NOW = 1_000_000_000
  __resetOpenaiLimitStateForTest()
  check('nothing observed initially', Object.keys(openaiObservedUsage()).length === 0)

  recordOpenaiRateHeaders(
    new Headers({
      'x-codex-secondary-used-percent': '42.5',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '328224',
    }),
    () => NOW,
  )
  const afterWeekly = openaiObservedUsage()
  check(
    'a stated band records used% + window + reset (reset anchored to now)',
    afterWeekly.secondary?.usedPct === 42.5 &&
      afterWeekly.secondary.windowMinutes === 10_080 &&
      afterWeekly.secondary.resetsAtMs === NOW + 328_224_000 &&
      afterWeekly.secondary.observedAtMs === NOW,
    JSON.stringify(afterWeekly),
  )
  check('the unstated band stays absent (absent ≠ zero)', afterWeekly.primary === undefined)

  recordOpenaiRateHeaders(new Headers({ 'content-type': 'application/json' }), () => NOW + 5_000)
  check(
    'a header-less response leaves the previous observation standing',
    openaiObservedUsage().secondary?.observedAtMs === NOW,
  )

  recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '7' }), () => NOW + 6_000)
  const partial = openaiObservedUsage().primary
  check(
    'a percent-only band records without inventing window/reset',
    partial?.usedPct === 7 && partial.windowMinutes === undefined && partial.resetsAtMs === undefined,
  )

  recordOpenaiRateHeaders(
    new Headers({ 'x-codex-primary-used-percent': 'not-a-number' }),
    () => NOW + 7_000,
  )
  check('a malformed percent is ignored (previous stands)', openaiObservedUsage().primary?.usedPct === 7)
  recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '250' }), () => NOW + 8_000)
  check('an out-of-range percent is ignored', openaiObservedUsage().primary?.usedPct === 7)
  recordOpenaiRateHeaders(undefined, () => NOW + 9_000)
  check('undefined headers are a no-op, never a throw', openaiObservedUsage().primary?.usedPct === 7)
  __resetOpenaiLimitStateForTest()
}

section('2 · window labels derive from the STATED length, never assumed')
{
  check("a week-class window (≥6d) is the weekly meter ('wk')", usageWindowLabel(10_080) === 'wk')
  check("a ~5.5-day statement still labels itself in days ('5d'/'6d')", /^[56]d$/.test(usageWindowLabel(5.5 * 24 * 60)))
  check("an hours-class window names its hours ('5h')", usageWindowLabel(300) === '5h')
  check("a minutes-class window names its minutes ('45m')", usageWindowLabel(45) === '45m')
  check("an UNSTATED length is the generic 'win' (never an invented shape)", usageWindowLabel(undefined) === 'win')
}

section('3 · activeSourceUsage — lane → kind → SHAPE, switch re-derives')
{
  const spendZero = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  const spendSome = { inputTokens: 1200, outputTokens: 300, costUSD: 0.42, models: 1 }
  const baseReads: ActiveUsageReads = {
    anthropicWindows: () => ({
      fiveHour: { key: '5h', usedPct: 31, resetsAtMs: 111, state: 'live' },
      sevenDay: { key: '7d', usedPct: 62, resetsAtMs: 222, state: 'live' },
    }),
    openaiObserved: () => ({
      secondary: { usedPct: 42.5, windowMinutes: 10_080, resetsAtMs: 999, observedAtMs: 555 },
    }),
    openaiLimited: () => ({ state: 'clear' }),
    zaiKeyPresent: () => true,
    spend: () => spendSome,
  }
  const subEntry = (provider: 'anthropic' | 'openai'): WalletEntry => ({
    id: `${provider}:oauth:x`,
    provider,
    kind: 'subscription-oauth',
    label: 'sub',
    custodian: provider === 'anthropic' ? 'anthropic-slots' : 'openai-accounts',
  })
  const keyEntry = (provider: 'anthropic' | 'openai'): WalletEntry => ({
    id: `${provider}:api-key:env`,
    provider,
    kind: 'api-key',
    label: 'key',
    custodian: 'provider-secrets',
  })

  const anth = activeSourceUsage({
    model: 'claude-fable-5',
    reads: { ...baseReads, activeEntry: p => (p === 'anthropic' ? subEntry('anthropic') : undefined) },
  })
  check(
    'anthropic subscription: windows shape, provider label, 5h+7d views',
    anth.shape === 'subscription-windows' &&
      anth.label === 'Anthropic usage' &&
      anth.windows.map(w => w.key).join(',') === '5h,7d' &&
      anth.windows[0]?.usedPct === 31,
    JSON.stringify(anth),
  )

  const oai = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...baseReads, activeEntry: p => (p === 'openai' ? subEntry('openai') : undefined) },
  })
  check(
    'openai subscription: windows shape, provider label, the weekly band only (no 5h row)',
    oai.shape === 'subscription-windows' &&
      oai.label === 'OpenAI usage' &&
      oai.windows.length === 1 &&
      oai.windows[0]?.key === 'wk' &&
      oai.windows[0].usedPct === 42.5 &&
      oai.windows[0].observedAtMs === 555,
    JSON.stringify(oai),
  )
  check('no reached limit ⇒ no limited field', oai.limited === undefined)
  check('an unstated subscription credit balance stays unreported', oai.credits?.state === 'unreported')
  const creditReads: ActiveUsageReads = {
    ...baseReads,
    activeEntry: p => (p === 'openai' ? subEntry('openai') : undefined),
    openaiObserved: () => ({
      ...baseReads.openaiObserved!(),
      credits: { hasCredits: true, unlimited: false, balance: '62500', source: 'endpoint', observedAtMs: 555 },
    }),
  }
  const credited = activeSourceUsage({ model: 'gpt-5.6-sol', reads: creditReads })
  const credits = openaiSubscriptionCredits(creditReads)
  check(
    'the subscription arm and credit owner report the endpoint balance without a currency',
    credits.state === 'reported' && credits.display === '62,500' && credits.compact === '62.5k' &&
      credits.source === 'endpoint' && credits.observedAtMs === 555 &&
      JSON.stringify(credited.credits) === JSON.stringify(credits),
    JSON.stringify(credited.credits),
  )

  const oaiLimited = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: {
      ...baseReads,
      activeEntry: p => (p === 'openai' ? subEntry('openai') : undefined),
      openaiLimited: () => ({ state: 'limited', resetsAtMs: 777, observedAtMs: 666 }),
    },
  })
  check('a reached limit surfaces with its observed reset', oaiLimited.limited?.resetsAtMs === 777)

  const key = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...baseReads, activeEntry: p => (p === 'openai' ? keyEntry('openai') : undefined) },
  })
  check(
    "api key: 'API usage' spend shape, zero windows",
    key.shape === 'api-spend' && key.label === 'API usage' && key.windows.length === 0 && key.spend.costUSD === 0.42,
  )

  const zai = activeSourceUsage({ model: 'glm-5.2', reads: baseReads })
  check("zai key: spend shape under the band's own name", zai.shape === 'api-spend' && zai.label === 'Z.AI usage')
  const zaiNone = activeSourceUsage({
    model: 'glm-5.2',
    reads: { ...baseReads, zaiKeyPresent: () => false, spend: () => spendZero },
  })
  check("zai uncredentialed: honest 'none' shape", zaiNone.shape === 'none' && zaiNone.sourceKind === 'none')

  const none = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...baseReads, activeEntry: () => undefined },
  })
  check("uncredentialed: shape 'none', provider-named label", none.shape === 'none' && none.label === 'OpenAI usage')

  const reads: ActiveUsageReads = {
    ...baseReads,
    activeEntry: p => (p === 'anthropic' ? subEntry('anthropic') : subEntry('openai')),
  }
  const beforeSwitch = activeSourceUsage({ model: 'claude-fable-5', reads })
  const afterSwitch = activeSourceUsage({ model: 'gpt-5.6-sol', reads })
  check(
    'model switch re-derives provider, label, and window set',
    beforeSwitch.provider === 'anthropic' &&
      afterSwitch.provider === 'openai' &&
      beforeSwitch.label !== afterSwitch.label &&
      beforeSwitch.windows.map(w => w.key).join(',') !== afterSwitch.windows.map(w => w.key).join(','),
  )

  const views = openaiObservedWindowViews(baseReads)
  check(
    'openaiObservedWindowViews = the same derivation (weekly view, stamped)',
    views.length === 1 && views[0]?.key === 'wk' && views[0].observedAtMs === 555,
  )
}

section('3b · the tier law — every tier word derives from the active source')
{
  const spendZero = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  const reads: ActiveUsageReads = {
    anthropicWindows: () => ({
      fiveHour: { key: '5h', usedPct: null, resetsAtMs: null, state: 'unavailable' },
      sevenDay: { key: '7d', usedPct: null, resetsAtMs: null, state: 'unavailable' },
    }),
    openaiObserved: () => ({}),
    openaiLimited: () => ({ state: 'clear' }),
    zaiKeyPresent: () => true,
    spend: () => spendZero,
  }
  const sub = (provider: 'anthropic' | 'openai', plan?: string): WalletEntry => ({
    id: `${provider}:oauth:x`,
    provider,
    kind: 'subscription-oauth',
    label: 'sub',
    ...(plan ? { identity: { plan } } : {}),
    custodian: provider === 'anthropic' ? 'anthropic-slots' : 'openai-accounts',
  })

  const claudeMax = activeSourceUsage({
    model: 'claude-fable-5',
    reads: { ...reads, activeEntry: p => (p === 'anthropic' ? sub('anthropic') : undefined), anthropicPlan: () => 'max' },
  })
  check("claude-sourced: the REAL Anthropic plan word ('Claude Max')", claudeMax.tier === 'Claude Max')
  const claudePlanless = activeSourceUsage({
    model: 'claude-fable-5',
    reads: { ...reads, activeEntry: p => (p === 'anthropic' ? sub('anthropic') : undefined), anthropicPlan: () => null },
  })
  check('claude-sourced, plan unstated: still names the subscription, invents nothing', claudePlanless.tier === 'Claude subscription')
  const gptPlus = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...reads, activeEntry: p => (p === 'openai' ? sub('openai', 'plus') : undefined) },
  })
  check("openai-sourced: the REAL ChatGPT tier from the custodian entry ('ChatGPT Plus')", gptPlus.tier === 'ChatGPT Plus')
  const keyTier = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: {
      ...reads,
      activeEntry: p =>
        p === 'openai'
          ? { id: 'openai:api-key:env', provider: 'openai', kind: 'api-key', label: 'key', custodian: 'provider-secrets' }
          : undefined,
    },
  })
  check("api-key billing: tier is 'API billing'", keyTier.tier === 'API billing')
  const zaiTier = activeSourceUsage({ model: 'glm-5.2', reads })
  check("every key lane carries the same billing tier word", zaiTier.tier === 'API billing')
  const noneTier = activeSourceUsage({
    model: 'claude-fable-5',
    reads: { ...reads, activeEntry: () => undefined, anthropicPlan: () => null },
  })
  check('tier is absent ONLY when nothing is logged in', noneTier.tier === undefined && noneTier.sourceKind === 'none')

}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL USAGE-TRUTH PROOFS PASS')
else console.log(`${failures} USAGE-TRUTH PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
