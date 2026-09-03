#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-usage-truth.ts
//
//  USAGE-TRUTH proof. Usage numbers are
//  perishable provider facts: ONE live owner (providerUsage.activeSourceUsage
//  over the claudeAiLimits / openaiLimitState stores), TWO renderers (the
//  settings Usage tab + the telemetry rail's USAGE panel), and the
//  dispatch-side throttles read the SAME stores — screen and throttle can
//  never disagree. This proof pins the MECHANISMS, never the numbers:
//
//    1. The x-codex header decode records ONLY what the source stated
//       (absent ≠ zero; malformed/out-of-range ignored; never throws).
//    2. Window labels DERIVE from the stated window length (≥6d = the
//       weekly meter) — never an assumed shape.
//    3. activeSourceUsage: the model decides the lane, the lane's active
//       entry decides the kind, the kind decides the SHAPE — subscription
//       windows for subscriptions, spend truth for API keys, honest 'none'
//       uncredentialed; a model/source switch re-derives (the repaint law).
//    4. The two-slot settings law + the rail's label/shape branches +
//       both-response-sites decode are pinned structurally.
//
//  Run:  ~/.bun/bin/bun run scripts/model-registry/prove-usage-truth.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recordOpenaiRateHeaders,
  openaiObservedUsage,
  __resetOpenaiLimitStateForTest,
} from '../../src/services/providers/openai/openaiLimitState.js'
import {
  activeSourceUsage,
  openaiObservedWindowViews,
  usageWindowLabel,
  type ActiveUsageReads,
} from '../../src/services/providers/providerUsage.js'
import type { WalletEntry } from '../../src/services/wallet/wallet.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' USAGE-TRUTH — one live owner, two renderers, honest shapes')
console.log('============================================================')

//
section('1 · the x-codex header decode — only what the source stated')
//
{
  const NOW = 1_000_000_000
  __resetOpenaiLimitStateForTest()
  check('nothing observed initially', Object.keys(openaiObservedUsage()).length === 0)

  // A weekly band, fully stated.
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

  // A later response with no usage headers changes nothing.
  recordOpenaiRateHeaders(new Headers({ 'content-type': 'application/json' }), () => NOW + 5_000)
  check(
    'a header-less response leaves the previous observation standing',
    openaiObservedUsage().secondary?.observedAtMs === NOW,
  )

  // Partial statement: used% alone records; window/reset stay absent.
  recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '7' }), () => NOW + 6_000)
  const partial = openaiObservedUsage().primary
  check(
    'a percent-only band records without inventing window/reset',
    partial?.usedPct === 7 && partial.windowMinutes === undefined && partial.resetsAtMs === undefined,
  )

  // Garbage never records and never throws.
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

//
section('2 · window labels derive from the STATED length, never assumed')
//
{
  check("a week-class window (≥6d) is the weekly meter ('wk')", usageWindowLabel(10_080) === 'wk')
  check("a ~5.5-day statement still labels itself in days ('5d'/'6d')", /^[56]d$/.test(usageWindowLabel(5.5 * 24 * 60)))
  check("an hours-class window names its hours ('5h')", usageWindowLabel(300) === '5h')
  check("a minutes-class window names its minutes ('45m')", usageWindowLabel(45) === '45m')
  check("an UNSTATED length is the generic 'win' (never an invented shape)", usageWindowLabel(undefined) === 'win')
}

//
section('3 · activeSourceUsage — lane → kind → SHAPE, switch re-derives')
//
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

  // Anthropic subscription → the 5h/7d windows, provider-labeled.
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

  // OpenAI subscription → the OBSERVED weekly band; no 5h row exists.
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

  // A reached limit rides the SAME record the dispatch pause reads.
  const oaiLimited = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: {
      ...baseReads,
      activeEntry: p => (p === 'openai' ? subEntry('openai') : undefined),
      openaiLimited: () => ({ state: 'limited', resetsAtMs: 777, observedAtMs: 666 }),
    },
  })
  check('a reached limit surfaces with its observed reset', oaiLimited.limited?.resetsAtMs === 777)

  // An active API key → billing/spend truth, never a subscription bar.
  const key = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...baseReads, activeEntry: p => (p === 'openai' ? keyEntry('openai') : undefined) },
  })
  check(
    "api key: 'API usage' spend shape, zero windows",
    key.shape === 'api-spend' && key.label === 'API usage' && key.windows.length === 0 && key.spend.costUSD === 0.42,
  )

  // Z.AI: key present ⇒ spend shape; absent ⇒ honest none.
  const zai = activeSourceUsage({ model: 'glm-5.2', reads: baseReads })
  check("zai key: 'API usage' spend shape", zai.shape === 'api-spend' && zai.label === 'API usage')
  const zaiNone = activeSourceUsage({
    model: 'glm-5.2',
    reads: { ...baseReads, zaiKeyPresent: () => false, spend: () => spendZero },
  })
  check("zai uncredentialed: honest 'none' shape", zaiNone.shape === 'none' && zaiNone.sourceKind === 'none')

  // Uncredentialed lane: honest none, provider still named.
  const none = activeSourceUsage({
    model: 'gpt-5.6-sol',
    reads: { ...baseReads, activeEntry: () => undefined },
  })
  check("uncredentialed: shape 'none', provider-named label", none.shape === 'none' && none.label === 'OpenAI usage')

  // THE SWITCH LAW: the same reads, a different model ⇒ a different source
  // derivation — the rail recomputes at render, so a source switch repaints
  // to the new shape (never a stale bar from the previous source).
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

  // The shared view derivation the settings tab reads is the same one.
  const views = openaiObservedWindowViews(baseReads)
  check(
    'openaiObservedWindowViews = the same derivation (weekly view, stamped)',
    views.length === 1 && views[0]?.key === 'wk' && views[0].observedAtMs === 555,
  )
}

//
section('3b · the tier law — every tier word derives from the active source')
//
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

  // The REAL plan word from the custodian, per source — never an invented tier.
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

  // The dead string + the derive law, structurally: no renderer invents a tier.
  const picker = src('src/components/MercuryModelPicker.tsx')
  check('the picker tier row derives from activeSourceUsage().tier', picker.includes('activeSourceUsage().tier'))
  check("the string 'Mercury Max' no longer exists as a tier anywhere in the picker", !picker.includes('Mercury Max'))
}

//
section('4 · structural — two slots, honest absences, one owner, both seams')
//
{
  const usageTab = src('src/components/Settings/Usage.tsx')
  check('settings: the Subscription slot heading mounts', usageTab.includes('SlotHeading text="Subscription"'))
  check('settings: the API-key slot component mounts for every section', (usageTab.match(/<ApiKeySlot/g) ?? []).length >= 3)
  // One slot grammar for every family: absentSlotLine composes the absent
  // body (none — <route> · n/a) and the key slot mounts it, never nothing.
  check(
    'settings: an absent key renders the honest none/n-a body (never a vanished slot)',
    usageTab.includes('return `none — ${route} · n/a`') &&
      usageTab.includes("<Text dimColor>{absentSlotLine('a pasted key attaches one')}</Text>"),
  )
  check(
    'settings: the OpenAI meters derive from the ONE owner (openaiObservedWindowViews)',
    usageTab.includes('openaiObservedWindowViews()'),
  )
  check(
    'settings: the honest OpenAI absence line exists (no fabricated meter)',
    usageTab.includes('no usage signal observed from the account source yet'),
  )
  check(
    'settings: wide terminals branch to left-to-right columns at 120',
    usageTab.includes('columns >= 120') && usageTab.includes('flexDirection="row"'),
  )
  check(
    'settings: meters cap to their column (columns never clip)',
    usageTab.includes('maxWidth ?? columns - 2'),
  )

  const rail = src('src/components/HelmTelemetryRail.tsx')
  check('rail: consumes the SAME owner (activeSourceUsage)', rail.includes('activeSourceUsage()'))
  check('rail: the quiet source label line exists', rail.includes('usage:source') && rail.includes('{usage.label}'))
  check(
    'rail: the api-spend branch renders spend truth, never a bar',
    rail.includes("usage.shape === 'api-spend'") && rail.includes('usage:spend'),
  )
  check(
    'rail: window rows ride the derived window key (source switches republish)',
    rail.includes('`usage:${w.key}`'),
  )

  const client = src('src/services/providers/openai/openaiClient.ts')
  check(
    'client: BOTH response seams fold the usage headers (stream + catalogue)',
    (client.match(/recordOpenaiRateHeaders\(response\.headers\)/g) ?? []).length === 2,
  )

  const facade = src('src/services/providers/providerUsage.ts')
  check(
    'facade: the one-owner law is written at the derivation (dispatch reads the same stores)',
    facade.includes('ONE derivation, TWO renderers') && facade.includes('can never disagree'),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL USAGE-TRUTH PROOFS PASS')
else console.log(`${failures} USAGE-TRUTH PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
