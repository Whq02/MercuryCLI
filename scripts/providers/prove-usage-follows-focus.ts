#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowSourceUsages, type ActiveUsageReads } from '../../src/services/providers/providerUsage.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

{
  const rail = readFileSync(join(import.meta.dir, '../../src/components/HelmTelemetryRail.tsx'), 'utf8')
  t(
    '§1 the rail reads the FOCUSED CONNECTOR model facts',
    rail.includes('getFocusedSessionConnector().modelFacts().main'),
  )
  t(
    '§1 …subscribed through the focused slot (hops and switches repaint)',
    rail.includes('subscribeThroughFocused') && rail.includes('connector.subscribeModel'),
  )
  t(
    '§1 …feeding the composed usages, never the bare global call',
    rail.includes('windowSourceUsages({ model: sessionModel })') && !/const usage = activeSourceUsage\(\)/.test(rail),
  )
  t(
    '§1 POISON: the AppState session-model read stays out of the rail (local-road-only, lies for daemon chats)',
    !rail.includes('s.mainLoopModelForSession'),
  )
  t('§1 …and paints the beside-accounts block', rail.includes('otherUsages'))
}

const now = Date.now()
const NO_SPEND = { models: 0, costUSD: 0 } as never

function reads(over: Partial<ActiveUsageReads>): ActiveUsageReads {
  return {
    spend: () => NO_SPEND,
    anthropicPlan: () => 'max',
    anthropicWindows: () => ({
      fiveHour: { key: '5h', state: 'live', usedPct: 41, resetsAtMs: now + 3_600_000 },
      sevenDay: { key: '7d', state: 'live', usedPct: 12, resetsAtMs: now + 86_400_000 },
    }) as never,
    anthropicPoolWindows: () => [],
    openaiObserved: () => ({
      primary: { usedPct: 33, windowMinutes: 10_080, resetsAtMs: now + 604_800_000, observedAtMs: now },
    }) as never,
    openaiLimited: () => ({ state: 'clear' }) as never,
    moonshotAccount: () => undefined,
    ...over,
  } as ActiveUsageReads
}

const OAUTH_ENTRY = { kind: 'oauth', identity: { plan: 'plus' } } as never

{
  const r = windowSourceUsages({
    model: 'gpt-5.6-sol',
    reads: reads({
      route: () => 'openai',
      activeEntry: provider => (provider === 'openai' || provider === 'anthropic' ? OAUTH_ENTRY : undefined),
    }),
  })
  t('§2 the focused GPT chat leads with the OpenAI source', r.primary.provider === 'openai', r.primary.provider)
  t('§2 …with its observed weekly window live', r.primary.windows.some(w => w.state === 'live'))
  t('§2 the Anthropic account rides beside with its windows', r.others.length === 1 && r.others[0]?.provider === 'anthropic' && (r.others[0]?.windows.filter(w => w.state === 'live').length ?? 0) === 2, JSON.stringify(r.others.map(o => o.provider)))
}

{
  const r = windowSourceUsages({
    model: 'fable-5',
    reads: reads({
      route: () => 'anthropic',
      activeEntry: provider => (provider === 'openai' || provider === 'anthropic' ? OAUTH_ENTRY : undefined),
    }),
  })
  t('§3 the focused Anthropic chat leads with the Anthropic source', r.primary.provider === 'anthropic')
  t('§3 the OpenAI account rides beside', r.others.length === 1 && r.others[0]?.provider === 'openai')
}

{
  const r = windowSourceUsages({
    model: 'gpt-5.6-sol',
    reads: reads({
      route: () => 'openai',
      activeEntry: provider => (provider === 'openai' ? OAUTH_ENTRY : undefined),
    }),
  })
  t('§4 a signed-out Anthropic lane adds no beside-row', r.others.every(o => o.provider !== 'anthropic'), JSON.stringify(r.others.map(o => o.provider)))
}

console.log(failures === 0 ? 'USAGE FOLLOWS FOCUS: ALL PASS' : 'USAGE FOLLOWS FOCUS: RED')
process.exit(failures)
