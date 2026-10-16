import { writeSync } from 'node:fs'
import { usagePopupLine } from '../../components/Settings/usageLine.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import {
  activeSourceUsage,
  providerFamilyPresences,
  presenceIdentityWords,
  refreshProviderUsage,
  sessionSpendByModel,
  sessionSpendOfFacts,
  usageForProvider,
  usageResetWords,
  type ActiveSourceUsage,
  type ProviderFamilyPresence,
  type ProviderSessionSpend,
  type UsageCreditsView,
  type UsageFigureView,
  type UsageWindowView,
} from '../../services/providers/providerUsage.js'
import { usageFreshness, usageSourceWords, type UsageFreshnessFacts } from '../../services/providers/usageFreshness.js'
import { getEngineModel } from '../../utils/model/model.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'

export const USAGE_READING_SCHEMA = 1

const iso = (ms: number | undefined): string | undefined => (ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString())

function freshnessOf(facts: UsageFreshnessFacts, now: number): { state: 'live' | 'stale' | 'unstamped'; ageMs?: number; words?: string } {
  const fresh = usageFreshness(facts, now)
  const words = usageSourceWords(facts, now)
  return { state: fresh.state, ...(fresh.state === 'unstamped' ? {} : { ageMs: fresh.ageMs }), ...(words === undefined ? {} : { words }) }
}

function windowReading(view: UsageWindowView, now: number): Record<string, unknown> {
  const resetsIn = usageResetWords(view.resetsAtMs, now)
  return {
    key: view.key,
    label: view.label,
    state: view.state,
    ...(view.usedPct === undefined ? {} : { usedPct: view.usedPct }),
    ...(iso(view.resetsAtMs) === undefined ? {} : { resetsAt: iso(view.resetsAtMs) }),
    ...(resetsIn === undefined ? {} : { resetsIn }),
    ...(iso(view.observedAtMs) === undefined ? {} : { observedAt: iso(view.observedAtMs) }),
    ...(view.source === undefined ? {} : { source: view.source }),
    freshness: freshnessOf(view, now),
  }
}

function figureReading(view: UsageFigureView, now: number): Record<string, unknown> {
  return {
    key: view.key,
    label: view.label,
    value: view.value,
    ...(iso(view.resetsAtMs) === undefined ? {} : { resetsAt: iso(view.resetsAtMs) }),
    ...(iso(view.observedAtMs) === undefined ? {} : { observedAt: iso(view.observedAtMs) }),
    ...(view.source === undefined ? {} : { source: view.source }),
    freshness: freshnessOf(view, now),
  }
}

function creditsReading(view: UsageCreditsView, now: number): Record<string, unknown> {
  return {
    state: view.state,
    ...(view.display === undefined ? {} : { display: view.display }),
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    ...(iso(view.observedAtMs) === undefined ? {} : { observedAt: iso(view.observedAtMs) }),
    ...(view.source === undefined ? {} : { source: view.source }),
    freshness: freshnessOf(view, now),
  }
}

function spendReading(spend: ProviderSessionSpend): Record<string, unknown> {
  return {
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    costUSD: spend.costUSD,
    models: spend.models,
    ...(spend.scheduled === undefined ? {} : { scheduled: spendReading(spend.scheduled) }),
    ...(spend.advisor === undefined ? {} : { advisor: spendReading(spend.advisor) }),
  }
}

function sourceReading(usage: ActiveSourceUsage, now: number): Record<string, unknown> {
  const facts = getFocusedSessionConnector().usage()
  const sessionSpend = sessionSpendOfFacts(facts, usage.provider)
  const byModel = sessionSpendByModel(facts, usage.provider).map(entry => ({ model: entry.model, spend: spendReading(entry.spend) }))
  return {
    provider: usage.provider,
    sourceKind: usage.sourceKind,
    label: usage.label,
    ...(usage.tier === undefined ? {} : { tier: usage.tier }),
    shape: usage.shape,
    windows: usage.windows.map(view => windowReading(view, now)),
    pools: usage.pools.map(view => windowReading(view, now)),
    ...(usage.binding === undefined ? {} : { binding: { windowName: usage.binding.windowName, ...(usage.binding.claim === undefined ? {} : { claim: usage.binding.claim }), window: windowReading(usage.binding.window, now) } }),
    ...(usage.credits === undefined ? {} : { credits: creditsReading(usage.credits, now) }),
    ...(usage.carry === undefined ? {} : { carry: { state: usage.carry.state, display: usage.carry.display } }),
    ...(usage.balance === undefined ? {} : { balance: { display: usage.balance.display, observedAt: iso(usage.balance.observedAtMs) } }),
    figures: (usage.figures ?? []).map(view => figureReading(view, now)),
    ...(usage.limited === undefined ? {} : { limited: { resetsAt: iso(usage.limited.resetsAtMs) } }),
    ...(usage.readerNote === undefined ? {} : { readerNote: usage.readerNote }),
    ...(usage.readerWait === undefined ? {} : { readerWait: usage.readerWait }),
    ...(usage.readerRecord === undefined ? {} : { readerRecord: usage.readerRecord }),
    ...(usage.absence === undefined ? {} : { absence: usage.absence }),
    ...(usage.whyNot === undefined ? {} : { whyNot: usage.whyNot }),
    spend: { ...spendReading(sessionSpend ?? usage.spend), byModel },
  }
}

function signInReading(presence: ProviderFamilyPresence): Record<string, unknown> {
  const identity = presenceIdentityWords(presence)
  return {
    provider: presence.id,
    credentialed: presence.credentialed,
    ...(presence.credentialLabel === undefined ? {} : { label: presence.credentialLabel }),
    ...(identity === undefined ? {} : { identity }),
    ...(presence.available ? {} : { unavailable: presence.reason ?? 'unavailable' }),
  }
}

export async function sampleShownFamilies(families: readonly ProviderFamilyPresence[]): Promise<RouterProviderId[]> {
  const sampled = families.filter(family => family.credentialed).map(family => family.id)
  await Promise.all(sampled.map(id => refreshProviderUsage(id, { reason: 'open' })))
  return sampled
}

export async function composeUsageReading(now: number = Date.now()): Promise<Record<string, unknown>> {
  const families = providerFamilyPresences()
  const sampled = await sampleShownFamilies(families)
  const active = activeSourceUsage()
  return {
    schema: USAGE_READING_SCHEMA,
    readAt: new Date(now).toISOString(),
    line: usagePopupLine(),
    model: getEngineModel(),
    sampled,
    signIns: families.map(signInReading),
    active: sourceReading(active, now),
    providers: families.filter(family => family.credentialed).map(family => sourceReading(family.id === active.provider ? active : usageForProvider(family.id), now)),
  }
}

export async function usageCli(opts: { json?: boolean }): Promise<void> {
  const reading = await composeUsageReading()
  const text = opts.json === true ? `${JSON.stringify(reading, null, 2)}\n` : `${String(reading.line)}\n`
  writeSync(1, text)
}
