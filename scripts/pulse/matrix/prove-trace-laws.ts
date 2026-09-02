#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-trace-laws.ts — the turn-trace laws
// unit level.
//
//  STATUS: GREEN against current HEAD — imports src/utils/pulse/turnTrace.ts
//  directly (no PTY, no dist, no integrator seams needed).
//
//  Laws pinned here:
//   · monotonic event times under a pinned clock
//   · generation fencing — stale marks/producer records dropped
//   · one turn ⇒ one trace (begin abandons an unfinished predecessor)
//   · ring cap 64 · event cap 256 + droppedEvents counting
//   · first_* / point latch semantics (retries can't rewrite history)
//   · summary math (ack/localPrep/providerWait/firstVisible/paint/slowest)
//   · cold/warm classification across the 5-minute idle gap
//   · percentile math over the ring
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-trace-laws.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { check, section, finish } from '../lib/proveKit.ts'
import {
  beginPulseTurn,
  completePulseTurn,
  getActivePulseTrace,
  getLatestPulseTrace,
  getPulseRing,
  pulseMark,
  pulsePercentile,
  pulseStageEnd,
  pulseStageStart,
  recordPulseProducer,
  resetPulseForTests,
} from '../../../src/utils/pulse/turnTrace.ts'
import { setPulseClockForTests, getPulsePhase, setPulsePhase } from '../../../src/utils/pulse/turnPhase.ts'

let now = 1000
setPulseClockForTests(() => now)

// ── monotonic event times ────────────────────────────────────────────────────
section('monotonic event times (pinned clock)')
{
  resetPulseForTests()
  const g = beginPulseTurn()
  now += 5
  pulseMark('acknowledgement_state_committed', undefined, g)
  now += 5
  pulseStageStart('input_processing', undefined, g)
  now += 7
  pulseStageEnd('input_processing', undefined, g)
  const t = getActivePulseTrace()!
  const times = t.events.map(e => e.at)
  check(
    'events stamp in non-decreasing clock order',
    times.every((v, i) => i === 0 || v >= times[i - 1]!),
    times.join(','),
  )
  check('submit_received is the first event', t.events[0]!.name === 'submit_received')
  completePulseTurn(g)
}

// ── generation fencing ──────────────────────────────────────────────────────
section('generation fencing')
{
  resetPulseForTests()
  const g1 = beginPulseTurn()
  completePulseTurn(g1)
  const g2 = beginPulseTurn()
  pulseMark('api_request_sent', undefined, g1) // stale — must drop
  recordPulseProducer('stale_producer', 10, 'ok', 1, g1) // stale — must drop
  const t = getActivePulseTrace()!
  check('stale-generation mark dropped', !t.events.some(e => e.name === 'api_request_sent'))
  check('stale-generation producer record dropped', t.producers.length === 0)
  check('phase generation matches the trace generation', getPulsePhase().generation === g2)
  const applied = setPulsePhase(g1, 'preparing')
  check('stale-generation phase write refused', applied === false)
  completePulseTurn(g2)
}

// ── one turn, one trace ─────────────────────────────────────────────────────
section('one turn ⇒ one trace (begin abandons an unfinished predecessor)')
{
  resetPulseForTests()
  const g1 = beginPulseTurn()
  pulseMark('acknowledgement_first_terminal_write', undefined, g1)
  const g2 = beginPulseTurn() // g1 never completed
  const ring = getPulseRing()
  check('abandoned predecessor summarized into the ring', ring.length === 1)
  check('…with status abandoned', ring[0]!.status === 'abandoned')
  check('the active trace is the new generation', getActivePulseTrace()!.generation === g2)
  completePulseTurn(g2)
}

// ── bounded growth ──────────────────────────────────────────────────────────
section('bounded growth: ring cap 64, event cap 256 + droppedEvents')
{
  resetPulseForTests()
  for (let i = 0; i < 70; i++) {
    const g = beginPulseTurn()
    now += 10
    completePulseTurn(g)
  }
  const ring = getPulseRing()
  check('ring capped at 64', ring.length === 64, String(ring.length))
  check('oldest summaries evicted (first surviving generation = 7)', ring[0]!.generation === 7)

  const g = beginPulseTurn()
  for (let i = 0; i < 300; i++) pulseMark(`custom_event_${i}`, undefined, g)
  const t = getActivePulseTrace()!
  check('events capped at 256', t.events.length === 256, String(t.events.length))
  // begin stamps submit_received (1) + 255 customs accepted; 300-255 dropped.
  check('overflow counted, never grown', t.droppedEvents === 45, String(t.droppedEvents))
  completePulseTurn(g)
}

// ── latch semantics ─────────────────────────────────────────────────────────
section('first_* point latch (retries cannot rewrite history)')
{
  resetPulseForTests()
  const g = beginPulseTurn()
  now = 2000
  pulseMark('first_text_delta', undefined, g)
  now = 2500
  pulseMark('first_text_delta', undefined, g) // must be ignored
  const t = getActivePulseTrace()!
  const stamps = t.events.filter(e => e.name === 'first_text_delta')
  check('duplicate first_text_delta ignored', stamps.length === 1)
  check('…and the FIRST stamp survives', stamps[0]!.at === 2000, String(stamps[0]!.at))
  // api_request_sent is deliberately NOT latched (tool-work re-dispatches).
  pulseMark('api_request_sent', undefined, g)
  pulseMark('api_request_sent', undefined, g)
  check(
    'api_request_sent is not latched (re-dispatch is real)',
    t.events.filter(e => e.name === 'api_request_sent').length === 2,
  )
  completePulseTurn(g)
}

// ── summary math ────────────────────────────────────────────────────────────
section('summary math (exact stamps under the pinned clock)')
{
  resetPulseForTests()
  now = 10_000
  const g = beginPulseTurn({ querySource: 'prompt' })
  now = 10_040
  pulseMark('acknowledgement_first_terminal_write', undefined, g)
  now = 10_100
  pulseStageStart('attachment_collection', undefined, g)
  now = 10_180
  pulseStageEnd('attachment_collection', undefined, g)
  recordPulseProducer('nested_memory', 80, 'ok', 2, g)
  recordPulseProducer('changed_files', 15, 'empty', 0, g)
  now = 10_200
  pulseStageStart('tool_schema', undefined, g)
  now = 10_230
  pulseStageEnd('tool_schema', undefined, g)
  now = 10_300
  pulseMark('api_request_sent', undefined, g)
  now = 11_200
  pulseMark('response_headers_received', undefined, g)
  now = 11_500
  pulseMark('first_stream_chunk_received', undefined, g)
  now = 11_600
  pulseMark('first_text_delta', undefined, g)
  now = 11_625
  pulseMark('first_text_terminal_write', undefined, g)
  now = 12_000
  const s = completePulseTurn(g)!
  check('ackMs = 40', s.ackMs === 40, String(s.ackMs))
  check('localPrepMs = 300', s.localPrepMs === 300, String(s.localPrepMs))
  check('providerWaitMs = 1200', s.providerWaitMs === 1200, String(s.providerWaitMs))
  check('firstVisibleMs = 1625 (text write; no thinking)', s.firstVisibleMs === 1625, String(s.firstVisibleMs))
  check('paintMs = 25', s.paintMs === 25, String(s.paintMs))
  check('totalMs = 2000', s.totalMs === 2000, String(s.totalMs))
  check('dispatched flagged', s.dispatched === true)
  check(
    'slowestStage = attachment_collection@80',
    s.slowestStage?.name === 'attachment_collection' && s.slowestStage.ms === 80,
    JSON.stringify(s.slowestStage),
  )
  check('producerCount = 2', s.producerCount === 2)
  check(
    'slowestProducer = nested_memory@80',
    s.slowestProducer?.label === 'nested_memory' && s.slowestProducer.ms === 80,
  )
  check('first turn classifies cold', s.cold === true)
  check('the settled trace stays readable', getLatestPulseTrace()!.generation === g)
}

// ── cold/warm classification ────────────────────────────────────────────────
section('cold/warm classification across the idle gap')
{
  resetPulseForTests()
  now = 100_000
  const g1 = beginPulseTurn()
  now = 100_500
  completePulseTurn(g1)
  now = 101_500 // 1s later — warm
  const g2 = beginPulseTurn()
  now = 101_800
  const s2 = completePulseTurn(g2)!
  check('short idle gap ⇒ warm', s2.cold === false)
  check('idleGapMs recorded', s2.idleGapMs === 1000, String(s2.idleGapMs))
  now = 101_800 + 5 * 60 * 1000 + 1 // > 5 min — cold again
  const g3 = beginPulseTurn()
  const s3 = completePulseTurn(g3)!
  check('post-idle turn re-classifies cold', s3.cold === true)
}

// ── percentile math ─────────────────────────────────────────────────────────
section('percentile math over the ring')
{
  resetPulseForTests()
  now = 1_000_000
  for (let i = 1; i <= 10; i++) {
    const g = beginPulseTurn()
    now += i * 10 // ack = 10,20,…,100
    pulseMark('acknowledgement_first_terminal_write', undefined, g)
    completePulseTurn(g)
    now += 1000
  }
  check('p50 over 10,…,100 = 50', pulsePercentile('ackMs', 50) === 50, String(pulsePercentile('ackMs', 50)))
  check('p95 over 10,…,100 = 100', pulsePercentile('ackMs', 95) === 100, String(pulsePercentile('ackMs', 95)))
  check('p0 = min', pulsePercentile('ackMs', 0) === 10, String(pulsePercentile('ackMs', 0)))
  check('filter narrows the sample set', pulsePercentile('ackMs', 100, s => (s.ackMs ?? 0) <= 30) === 30)
  check('no samples ⇒ null', pulsePercentile('providerWaitMs', 95) === null)
}

setPulseClockForTests(null)
finish('PULSE trace laws')
