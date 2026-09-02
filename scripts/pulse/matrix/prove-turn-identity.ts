#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-turn-identity.ts — cancellation + queued
//  steering keep turn identity clean on the SHIPPED artifact
//  ("no phase from an old/cancelled
//  turn mutating a newer turn; cancellation, queued prompts").
//
//  STATUS: LIVE — needs the MERCURY_PULSE_DUMP seam.
//  The unit-level fencing laws live in prove-trace-laws/prove-phase-laws;
//  this file pins the same identity contract END TO END: a real ESC across
//  a hanging stream, a real queued submit across a live stream.
//
//  Laws:
//   · scene 11 — the cancelled turn settles with a non-complete status; the
//     resubmit gets its OWN generation, dispatches, completes, and its
//     summary is unpolluted (its spine stamps are its own, later than the
//     cancelled turn's).
//   · scene 12 — a submit during a live stream queues; two turns ⇒ two
//     complete traces in generation order, the second dispatching only
//     after the first settled.
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-turn-identity.ts
// ============================================================================

import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { sceneByKey, runScene } from './scenes.ts'

requireDistSeam('MERCURY_PULSE_DUMP', 'prove-turn-identity')
armWatchdog('PULSE turn identity', 240_000)

const cancel = await runScene(sceneByKey('cancel-resubmit'))
const steer = await runScene(sceneByKey('queued-steering'))

type Line = { events: { name: string; at: number }[]; summary: Record<string, unknown> }
function at(line: Line, name: string): number | null {
  const e = line.events.find(ev => ev.name === name)
  return e ? e.at : null
}

// The session-title side call rides the small model; the law counts the
// MAIN model's requests (both scenes filter with this).
const mainModel = (r: { body: unknown }): boolean =>
  String((r.body as { model?: string }).model ?? '').includes('opus')

section('scene 11 — ESC cancel + immediate resubmit')
{
  const cancelMain = cancel.fixture.messageRequests().filter(mainModel).length
  check('two fixture requests (the hang + the resubmit)', cancelMain === 2, `${cancelMain} main-model request(s)`)
  check('two dump lines — the cancelled turn still settles a trace', cancel.pulse.length === 2, String(cancel.pulse.length))
  const [g1, g2] = cancel.pulse as [Line, Line]
  check(
    'the cancelled turn does NOT claim complete',
    g1.summary.status !== 'complete',
    String(g1.summary.status),
  )
  check('the resubmit completes', g2.summary.status === 'complete')
  check(
    'generations strictly increase across the cancel',
    Number(g2.summary.generation) > Number(g1.summary.generation),
  )
  const g1Submit = at(g1, 'submit_received')
  const g2Submit = at(g2, 'submit_received')
  const g2Sent = at(g2, 'api_request_sent')
  check('the resubmit owns its own spine (submit → dispatch, after the cancel)',
    g1Submit !== null && g2Submit !== null && g2Sent !== null && g2Submit > g1Submit && g2Sent > g2Submit,
  )
  check(
    'no cross-pollution: the resubmit trace never contains the hang sentinel stages twice',
    g2.events.filter(e => e.name === 'submit_received').length === 1,
  )
}

section('scene 12 — queued steering across a live stream')
{
  const steerMain = steer.fixture.messageRequests().filter(mainModel).length
  check('two fixture requests', steerMain === 2, `${steerMain} main-model request(s)`)
  check('two dump lines', steer.pulse.length === 2, String(steer.pulse.length))
  const [g1, g2] = steer.pulse as [Line, Line]
  check('both turns complete', g1.summary.status === 'complete' && g2.summary.status === 'complete')
  check(
    'generations strictly increase',
    Number(g2.summary.generation) > Number(g1.summary.generation),
  )
  const g1Done = at(g1, 'turn_complete')
  const g2Sent = at(g2, 'api_request_sent')
  check(
    'the queued turn dispatches only after the live turn settled',
    g1Done !== null && g2Sent !== null && g2Sent > g1Done,
    g1Done !== null && g2Sent !== null ? `Δ=${Math.round(g2Sent - g1Done)}ms` : '',
  )
  check(
    'the queued turn still owns a full spine (dispatched + completed)',
    g2.summary.dispatched === true && typeof g2.summary.localPrepMs === 'number',
  )
}

cancel.cleanup()
steer.cleanup()
finish('PULSE turn identity')
