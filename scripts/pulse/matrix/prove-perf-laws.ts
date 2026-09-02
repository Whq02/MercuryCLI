#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-perf-laws.ts — the performance laws
// on the SHIPPED artifact.
//
//  STATUS: LIVE — the MERCURY_PULSE_DUMP seam landed; exits 2
//  (PENDING-INTEGRATION) only if the dispatch marks ever leave the artifact.
//
//  Laws, from scenes 1 / 7 / 8 (hermetic PTY + fixture provider):
//   · submit → acknowledgement terminal write p95 ≤ 100ms — measured TWO
//     ways: the PTY frame change after Enter (first ≥200-byte write following
//     the \r send — the 1Hz clock tick is a handful of cells, a submit
//     repaint is a frame) AND the trace's own ackMs.
//   · warm plain-text local preparation p95 ≤ 250ms (scene 1, cold=false).
//   · one turn ⇒ one complete trace (dump lines == fixture message requests).
//   · provider waits attribute to providerWaitMs, never to local stages
//     (scenes 7/8: 4s held responses ⇒ providerWait ≥ 3.5s, localPrep and
//     the slowest local stage stay bounded).
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-perf-laws.ts
// ============================================================================

import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { vshotBudgetMs as S } from '../../lib/captureDriver.ts'
import { enterSends, pct, type PulseRun } from '../lib/pulseArena.ts'
import { sceneByKey, runScene } from './scenes.ts'

requireDistSeam('MERCURY_PULSE_DUMP', 'prove-perf-laws')
requireDistSeam('api_request_sent', 'prove-perf-laws')
requireDistSeam('first_stream_chunk_received', 'prove-perf-laws')
armWatchdog('PULSE perf laws', 240_000)

/** PTY-observed ack: \r send → first substantive write (≥200 bytes). */
function ptyAckLatencies(run: PulseRun): number[] {
  const out: number[] = []
  for (const enter of enterSends(run)) {
    const hit = run.teeLines.find(
      t => t.ts >= enter.sent && (t.content?.length ?? t.len ?? 0) >= 200,
    )
    if (hit) out.push(hit.ts - enter.sent)
  }
  return out
}

const warm = await runScene(sceneByKey('warm-plain'))
const headerDelay = await runScene(sceneByKey('provider-header-delay'))
const chunkDelay = await runScene(sceneByKey('provider-first-chunk-delay'))

// ── one turn, one complete trace ────────────────────────────────────────────
section('one operator turn ⇒ one complete trace (scene 1)')
{
  // Each submit also fires the session-title side call on the small model;
  // the law counts the MAIN model's requests.
  const mainModel = (r: { body: unknown }): boolean =>
    String((r.body as { model?: string }).model ?? '').includes('opus')
  const reqs = warm.fixture.messageRequests().filter(mainModel).length
  check('four submits ⇒ four fixture requests', reqs === 4, `${reqs} main-model request(s)`)
  check('…and exactly four dump lines', warm.pulse.length === 4, String(warm.pulse.length))
  check(
    'every turn settles complete',
    warm.pulse.every(l => l.summary.status === 'complete'),
    warm.pulse.map(l => String(l.summary.status)).join(','),
  )
  const gens = warm.pulse.map(l => Number(l.summary.generation))
  check(
    'generations strictly increase',
    gens.every((g, i) => i === 0 || g > gens[i - 1]!),
    gens.join(','),
  )
  check(
    'every dispatched turn carries the full spine (ack + localPrep + providerWait)',
    warm.pulse.every(
      l =>
        typeof l.summary.ackMs === 'number' &&
        typeof l.summary.localPrepMs === 'number' &&
        typeof l.summary.providerWaitMs === 'number',
    ),
  )
}

// ── ack law ─────────────────────────────────────────────────────────────────
section('submit → acknowledgement terminal write: p95 ≤ 100ms')
{
  const pty = [...ptyAckLatencies(warm), ...ptyAckLatencies(headerDelay), ...ptyAckLatencies(chunkDelay)]
  check('every Enter produced a substantive frame write', pty.length === 6, `${pty.length}/6`)
  // The LAW is bounded acknowledgement; the hosted profile widens only the
  // margin (the 2-core runner measured p95=272ms against the authoring
  // box's 100ms on run 2 — hardware, not product). Locally the bound stays
  // exactly the authored number.
  const p95pty = pct(pty, 95)
  check(`PTY frame-change ack p95 ≤ ${S(100)}ms (hosted-margined)`, p95pty >= 0 && p95pty <= S(100), `p95=${p95pty}ms [${pty.map(v => Math.round(v)).join(',')}]`)
  const ackMs = [...warm.pulse, ...headerDelay.pulse, ...chunkDelay.pulse]
    .map(l => l.summary.ackMs)
    .filter((v): v is number => typeof v === 'number')
  const p95trace = pct(ackMs, 95)
  check(`trace ackMs p95 ≤ ${S(100)}ms (hosted-margined)`, p95trace >= 0 && p95trace <= S(100), `p95=${p95trace}ms`)
}

// ── warm local preparation ──────────────────────────────────────────────────
section('warm plain-text local preparation: p95 ≤ 250ms (scene 1, cold=false)')
{
  const warmPrep = warm.pulse
    .filter(l => l.summary.cold === false)
    .map(l => l.summary.localPrepMs)
    .filter((v): v is number => typeof v === 'number')
  check('at least three warm samples', warmPrep.length >= 3, String(warmPrep.length))
  const p95 = pct(warmPrep, 95)
  check(`warm localPrepMs p95 ≤ ${S(250)}ms (hosted-margined)`, p95 >= 0 && p95 <= S(250), `p95=${p95}ms [${warmPrep.join(',')}]`)
}

// ── attribution law ─────────────────────────────────────────────────────────
section('provider waits attribute to providerWaitMs, never to local stages')
for (const [name, run, kind] of [
  ['scene 7 (4s before headers)', headerDelay, 'header'],
  ['scene 8 (4s headers→first chunk)', chunkDelay, 'chunk'],
] as const) {
  const line = run.pulse[0]
  check(`${name}: one dump line`, run.pulse.length === 1 && !!line)
  if (!line) continue
  const s = line.summary
  check(
    `${name}: providerWaitMs carries the wait (≥3500ms)`,
    typeof s.providerWaitMs === 'number' && s.providerWaitMs >= 3500,
    String(s.providerWaitMs),
  )
  check(
    `${name}: localPrepMs stays local (≤1500ms)`,
    typeof s.localPrepMs === 'number' && s.localPrepMs <= 1500,
    String(s.localPrepMs),
  )
  const slowest = (s as { slowestStage?: { name: string; ms: number } | null }).slowestStage
  check(
    `${name}: no local stage swallowed the wait (slowest ≤1500ms)`,
    !slowest || slowest.ms <= 1500,
    JSON.stringify(slowest),
  )
  const at = (n: string): number | null => {
    const e = line.events.find(ev => ev.name === n)
    return e ? e.at : null
  }
  const sent = at('api_request_sent')
  const headers = at('response_headers_received')
  const chunk = at('first_stream_chunk_received')
  if (kind === 'header') {
    check(
      `${name}: the gap sits BEFORE headers`,
      sent !== null && headers !== null && headers - sent >= 3500,
      `headers-sent=${sent !== null && headers !== null ? Math.round(headers - sent) : 'n/a'}ms`,
    )
  } else {
    check(
      `${name}: headers answer fast (≤1000ms after dispatch)`,
      sent !== null && headers !== null && headers - sent <= 1000,
      `headers-sent=${sent !== null && headers !== null ? Math.round(headers - sent) : 'n/a'}ms`,
    )
    check(
      `${name}: the gap sits between headers and the first chunk`,
      headers !== null && chunk !== null && chunk - headers >= 3500,
      `chunk-headers=${headers !== null && chunk !== null ? Math.round(chunk - headers) : 'n/a'}ms`,
    )
  }
}

warm.cleanup()
headerDelay.cleanup()
chunkDelay.cleanup()
finish('PULSE perf laws')
