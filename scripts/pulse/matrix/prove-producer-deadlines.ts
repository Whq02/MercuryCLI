#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-producer-deadlines.ts — attachment producer
//  timing + REAL deadline behavior.
//
//  STATUS: LIVE mechanics / Slice-4 ACCEPTANCE — needs MERCURY_PULSE_DUMP +
//  MERCURY_PULSE_FIXTURE (both landed; exits 2 only if they leave
//  the artifact). NOTE: the real-deadline law is the Slice-4 acceptance bar —
//  against a pre-Slice-4 artifact this file measures the defect and goes RED
//  (observed: the stuck producer held submission the full 2500ms;
//  "a timer that only aborts a signal while Promise.all continues waiting is
//  not a deadline").
//
//  Laws:
//   · every injected producer is RECORDED with duration + outcome (scene 4).
//   · a producer that ignores cancellation surfaces as a timeout outcome
//     while the turn still completes, and attachment_collection ends under a
//     real deadline — not at the stuck producer's leisure (scene 5).
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-producer-deadlines.ts
// ============================================================================

import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { sceneByKey, runScene } from './scenes.ts'

requireDistSeam('MERCURY_PULSE_DUMP', 'prove-producer-deadlines')
requireDistSeam('MERCURY_PULSE_FIXTURE', 'prove-producer-deadlines')
armWatchdog('PULSE producer deadlines', 180_000)

const slow = await runScene(sceneByKey('producer-slow'))
const stuck = await runScene(sceneByKey('producer-stuck'))

type Line = {
  events: { name: string; at: number }[]
  producers: { label: string; ms: number; outcome: string; count: number }[]
  summary: Record<string, unknown>
}
function at(line: Line, name: string): number | null {
  const e = line.events.find(ev => ev.name === name)
  return e ? e.at : null
}

section('scene 4 — the slow cooperative producer is recorded, turn unharmed')
{
  check('one dump line', slow.pulse.length === 1)
  const line = slow.pulse[0]!
  const rec = line.producers.find(p => p.label.includes('slow'))
  check('the injected producer has a record', !!rec, line.producers.map(p => p.label).join(','))
  if (rec) {
    check('…with a real duration', typeof rec.ms === 'number' && rec.ms > 0, String(rec.ms))
    check('…and an outcome label', typeof rec.outcome === 'string' && rec.outcome.length > 0, rec.outcome)
  }
  check(
    'EVERY producer carries duration + outcome (no 5% sampling)',
    line.producers.length >= 40 &&
      line.producers.every(p => typeof p.ms === 'number' && typeof p.outcome === 'string'),
    String(line.producers.length),
  )
  check('the turn dispatches and completes', line.summary.status === 'complete' && line.summary.dispatched === true)
}

section('scene 5 — the stuck producer meets a REAL deadline (Slice-4 acceptance)')
{
  check('one dump line', stuck.pulse.length === 1)
  const line = stuck.pulse[0]!
  const rec = line.producers.find(p => p.label.includes('stuck'))
  check('the stuck producer has a record', !!rec, line.producers.map(p => p.label).filter(l => l.startsWith('pulse')).join(','))
  if (rec) {
    check(
      'the stuck producer surfaces as a timeout outcome',
      rec.outcome === 'timeout',
      `outcome=${rec.outcome} ms=${rec.ms}`,
    )
  }
  check('the turn STILL completes', line.summary.status === 'complete' && line.summary.dispatched === true)
  const start = at(line, 'attachment_collection_start')
  const end = at(line, 'attachment_collection_end')
  check('attachment_collection stage present', start !== null && end !== null)
  if (start !== null && end !== null) {
    check(
      'collection ends under a real deadline (< 2400ms — NOT the stuck producer’s 2500ms)',
      end - start < 2400,
      `${Math.round(end - start)}ms — the abort signal is decorative, Promise.all still waited`,
    )
  }
}

slow.cleanup()
stuck.cleanup()
finish('PULSE producer deadlines')
