#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-dispatch-vs-entry.ts — actual request dispatch
//  ≠ query() entry.
//
//  STATUS: LIVE — needs the MERCURY_PULSE_DUMP seam;
//  exits 2 (PENDING-INTEGRATION) only if the marks leave the artifact.
//
//  The old defect: stream_request_start was emitted at query() entry —
//  before compaction, tool-schema construction, normalization and client
//  setup — so "requesting" lied. The law: api_request_sent stamps STRICTLY
//  AFTER attachment_collection_end, tool_schema_end and
//  message_normalization_end (and after query_loop_entered), on every
//  dispatched turn. "Requesting" can only mean the fetch actually left.
//
//  Also pins scene 6 (autocompact): the compaction runs INSIDE the traced
//  span, before dispatch, and the trace records whether it compacted.
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-dispatch-vs-entry.ts
// ============================================================================

import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { sceneByKey, runScene } from './scenes.ts'

// NB: stage events are composed at runtime (`${stage}_start`) — gate on the
// stage-name literals, which DO live in the bundle at the call sites.
requireDistSeam('MERCURY_PULSE_DUMP', 'prove-dispatch-vs-entry')
requireDistSeam('api_request_sent', 'prove-dispatch-vs-entry')
requireDistSeam('tool_schema', 'prove-dispatch-vs-entry')
requireDistSeam('message_normalization', 'prove-dispatch-vs-entry')
armWatchdog('PULSE dispatch vs entry', 180_000)

const textFirst = await runScene(sceneByKey('text-first'))
const compact = await runScene(sceneByKey('autocompact'))

type Line = { events: { name: string; at: number; data?: Record<string, unknown> }[] }
function at(line: Line, name: string): number | null {
  const e = line.events.find(ev => ev.name === name)
  return e ? e.at : null
}

section('scene 10 — dispatch stamps after every local preparation stage')
{
  check('one dump line', textFirst.pulse.length === 1)
  const line = textFirst.pulse[0]!
  const sent = at(line, 'api_request_sent')
  check('api_request_sent present', sent !== null)
  for (const stage of [
    'attachment_collection_end',
    'tool_schema_end',
    'message_normalization_end',
    'client_setup_end',
    'query_loop_entered',
  ]) {
    const t = at(line, stage)
    check(
      `api_request_sent strictly after ${stage}`,
      t !== null && sent !== null && sent > t,
      t === null ? `${stage} MISSING from the trace` : `Δ=${sent !== null ? (sent - t).toFixed(1) : '?'}ms`,
    )
  }
  const headers = at(line, 'response_headers_received')
  check(
    'response headers arrive only after dispatch',
    headers !== null && sent !== null && headers > sent,
  )
}

section('scene 6 — autocompact rides inside the traced span, before dispatch')
{
  // The MAIN model's requests: the small-model side call the submit fires
  // (the session title) is its own law, never this count.
  const mainRequests = compact.fixture
    .messageRequests()
    .filter(r => String((r.body as { model?: unknown }).model ?? '').includes('opus'))
  check('three fixture requests (turn 1 + summarization + turn 2)', mainRequests.length === 3, String(mainRequests.length))
  check('two dump lines (the compact call is NOT an operator turn)', compact.pulse.length === 2, String(compact.pulse.length))
  const g2 = compact.pulse[1]!
  const acStart = at(g2, 'autocompact_start')
  const acEnd = at(g2, 'autocompact_end')
  const sent = at(g2, 'api_request_sent')
  check('autocompact stage present on the triggering turn', acStart !== null && acEnd !== null)
  check(
    'the compaction really ran (stage ≥ 20ms — decision + summarization call)',
    acStart !== null && acEnd !== null && acEnd - acStart >= 20,
    acStart !== null && acEnd !== null ? `${(acEnd - acStart).toFixed(1)}ms` : '',
  )
  check('…and closed before actual dispatch', acEnd !== null && sent !== null && acEnd < sent)
  const endEvent = g2.events.find(e => e.name === 'autocompact_end')
  check(
    'the trace records that it actually compacted (data.compacted === true)',
    endEvent?.data?.compacted === true,
    JSON.stringify(endEvent?.data),
  )
  const g1End = compact.pulse[0]!.events.find(e => e.name === 'autocompact_end')
  check(
    'the sub-threshold turn honestly records compacted === false',
    g1End?.data?.compacted === false,
    JSON.stringify(g1End?.data),
  )
}

textFirst.cleanup()
compact.cleanup()
finish('PULSE dispatch vs entry')
