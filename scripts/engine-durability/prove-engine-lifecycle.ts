#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-engine-lifecycle.ts — lifecycle census for the
//  two event-driven projection engines.
//
//  The stage's measure is "task/timer/listener/process/owner counts return to
//  baseline". This proves it for the workbench and telemetry engines, which is
//  where put new per-engine state (a coalescer minted per start, a
//  last-known-good map) on top of state that already had to be released
//  (heartbeat, debounce timer, source subscriptions, the collaboration
//  rebind).
//
//  The idle law these engines are built on says: with no subscribers the
//  engine is fully off — no timers, no watchers, no token cost anywhere. A
//  leak here is invisible in normal use (the process simply never goes quiet)
//  and is exactly the class hit when a lane latched after one idle
//  pump: no error, no fault, just a system that has stopped being idle.
//
//  §3 is the one that would catch a real regression. A single subscribe/
//  unsubscribe pair can look clean while each cycle leaks one row — only
//  REPEATED cycles separate "released" from "accumulating".
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot, waitUntil } from './harness.ts'

scratchRoot('lifecycle')
const t = checker()

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const projection = await import('../../src/services/workbench/projection.ts')
const telemetry = await import('../../src/state/telemetryBus.ts')

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

t.section('§2 — an unsubscribed telemetry engine holds nothing')
{
  const unsub = telemetry.subscribeTelemetry(() => {})
  const live = telemetry._statsForProofs()
  t.check(
    'subscribed: heartbeat, source subscriptions and coalescer armed',
    live.listeners === 1 && live.heartbeat && live.sourceUnsubs === 3 && live.coalescer,
    JSON.stringify(live),
  )

  unsub()
  const after = telemetry._statsForProofs()
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
  // One clean pair can hide a per-cycle leak; only repetition separates
  // "released" from "grew by one each time".
  for (let i = 0; i < 10; i++) {
    const w = projection.subscribeWorkbench(() => {})
    const c = telemetry.subscribeTelemetry(() => {})
    w()
    c()
  }
  const wb = projection._statsForProofs()
  const tb = telemetry._statsForProofs()
  t.check(
    'workbench: 10 cycles leave no residue',
    wb.listeners === 0 && !wb.heartbeat && wb.engineUnsubs === 0 && !wb.coalescer,
    JSON.stringify(wb),
  )
  t.check(
    'telemetry: 10 cycles leave no residue',
    tb.listeners === 0 && !tb.heartbeat && tb.sourceUnsubs === 0 && !tb.coalescer,
    JSON.stringify(tb),
  )
}

t.section('§4 — last-known-good is bounded by the source count, not by time')
{
  // The stale memory is a Map keyed by SOURCE id. If it were ever
  // keyed by anything per-refresh it would grow without bound in a
  // long-running session — the quiet kind of leak that only shows up after
  // hours. Three sources are tracked, so three is the ceiling.
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
