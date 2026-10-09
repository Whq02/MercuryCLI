#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot, waitUntil } from './harness.ts'

scratchRoot('lifecycle')
const t = checker()

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const projection = await import('../../src/services/workbench/projection.ts')
const vitals = await import('../../src/state/vitalsBus.ts')

t.section('§1 — an unsubscribed workbench engine holds nothing')
{
  projection._resetWorkbenchForTesting()
  const idle = projection._statsForProofs()
  t.check(
    'idle: no listeners, no timers, no subscriptions, no coalescer',
    idle.listeners === 0 &&
      !idle.heartbeat &&
      !idle.debounceTimer &&
      idle.engineUnsubs === 0 &&
      !idle.collabUnsub &&
      !idle.coalescer,
    JSON.stringify(idle),
  )

  const unsub = projection.subscribeWorkbench(() => {})
  await waitUntil(() => (projection.getWorkbenchSnapshot()?.version ?? 0) > 0)
  const live = projection._statsForProofs()
  t.check(
    'subscribed: the engine armed its heartbeat, sources and coalescer',
    live.listeners === 1 && live.heartbeat && live.engineUnsubs > 0 && live.coalescer,
    JSON.stringify(live),
  )

  unsub()
  const after = projection._statsForProofs()
  t.check(
    'unsubscribed: every resource returned to baseline',
    after.listeners === 0 &&
      !after.heartbeat &&
      !after.debounceTimer &&
      after.engineUnsubs === 0 &&
      !after.collabUnsub &&
      !after.coalescer,
    JSON.stringify(after),
  )
}

t.section('§2 — an unsubscribed vitals engine holds nothing')
{
  const unsub = vitals.subscribeVitals(() => {})
  const live = vitals._statsForProofs()
  t.check(
    'subscribed: heartbeat, source subscriptions and coalescer armed',
    live.listeners === 1 && live.heartbeat && live.sourceUnsubs === 4 && live.coalescer,
    JSON.stringify(live),
  )

  unsub()
  const after = vitals._statsForProofs()
  t.check(
    'unsubscribed: every resource returned to baseline',
    after.listeners === 0 &&
      !after.heartbeat &&
      !after.debounceTimer &&
      after.sourceUnsubs === 0 &&
      !after.coalescer,
    JSON.stringify(after),
  )
}

t.section('§3 — repeated start/stop cycles do not accumulate')
{
  for (let i = 0; i < 10; i++) {
    const w = projection.subscribeWorkbench(() => {})
    const c = vitals.subscribeVitals(() => {})
    w()
    c()
  }
  const wb = projection._statsForProofs()
  const tb = vitals._statsForProofs()
  t.check(
    'workbench: 10 cycles leave no residue',
    wb.listeners === 0 && !wb.heartbeat && wb.engineUnsubs === 0 && !wb.coalescer,
    JSON.stringify(wb),
  )
  t.check(
    'vitals: 10 cycles leave no residue',
    tb.listeners === 0 && !tb.heartbeat && tb.sourceUnsubs === 0 && !tb.coalescer,
    JSON.stringify(tb),
  )
}

t.section('§4 — last-known-good is bounded by the source count, not by time')
{
  projection._resetWorkbenchForTesting()
  const unsub = projection.subscribeWorkbench(() => {})
  await waitUntil(() => (projection.getWorkbenchSnapshot()?.version ?? 0) > 0)
  const before = projection._statsForProofs().lastGood
  for (let i = 0; i < 12; i++) projection.pokeWorkbench()
  await waitUntil(() => (projection.getWorkbenchSnapshot()?.version ?? 0) > 1)
  const after = projection._statsForProofs().lastGood
  t.check(
    'the stale memory never exceeds the tracked source count',
    after <= 3 && before <= 3,
    `before=${before} after=${after}`,
  )
  unsub()
  t.check(
    'and it is cleared with the engine',
    (projection._resetWorkbenchForTesting(), projection._statsForProofs().lastGood === 0),
  )
}

t.finish('prove-engine-lifecycle')
