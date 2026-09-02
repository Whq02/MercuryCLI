// ============================================================================
//  utils/flux/fluxProbe — the terminal-fluidity probe ring
//
//
//  A disabled-by-default, bounded, monotonic-clock instrumentation layer for
//  the event→state→commit→frame→write pipeline. Gated on MERCURY_FLUX_PROBE
//  (registered, opt-in, session-latched like the Cache Clock — a probe that
//  flips mid-session would corrupt its own aggregates). When disabled every
//  entry point is a latched-boolean check + return: zero allocation, zero
//  ordering change, zero user-visible semantics — the probe only ever
//  OBSERVES numbers that already exist at its call sites.
//
//  Consumers:
//   • src/ink/ink.tsx onRender tail — per-frame duration + patch count;
//   • the stream fan-out / tail store — delta + commit counters (S2);
//   • the frame scheduler — coalesced / urgent / stale-dropped counters (S8);
//   • /doctor row + scripts/streaming benches — fluxSummary().
//
//  Bounded: marks and frame durations live in fixed-capacity rings; counters
//  are a small Map<string, number>. Nothing here logs per token.
// ============================================================================

import { writeFileSync } from 'node:fs'
import { isEnvTruthy } from '../envUtils.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

let latched: boolean | null = null

/** Session-latched MERCURY_FLUX_PROBE gate (probe aggregates must not span a
 *  mid-session flip). Proofs use __fluxProbeResetForTest to re-latch. */
export function fluxProbeEnabled(): boolean {
  if (latched === null) {
    latched = isEnvTruthy(flagEnv('MERCURY_FLUX_PROBE'))
    if (latched) armProbeTee()
  }
  return latched
}

/** MERCURY_FLUX_PROBE_TEE=path: dump the FULL probe state (all ring marks +
 *  the epoch↔monotonic clock offset) as JSON at graceful shutdown, so
 *  out-of-process proofs (scripts/streaming/prove-region-matrix.ts) can window
 *  in-process render marks against wall-clock PTY events. Best-effort —
 *  never blocks or fails shutdown. */
let teeArmed = false
let teeWritten = false
function writeProbeTee(path: string): void {
  if (teeWritten) return
  // A process that recorded nothing says nothing: the cockpit's children
  // (the daemon, the session runner) inherit the tee path and the probe
  // flag, arm the tee on their first probe call, and at THEIR exit wrote an
  // empty dump over the cockpit's — the reader then found zero marks where
  // the matrix had just counted hundreds.
  const dump = fluxProbeDump()
  if (dump.allMarks.length === 0 && dump.frames.total === 0) return
  teeWritten = true
  try {
    writeFileSync(path, JSON.stringify(dump))
  } catch {
    // best-effort tee
  }
}
function armProbeTee(): void {
  const path = flagEnv('MERCURY_FLUX_PROBE_TEE')
  if (!path || teeArmed) return
  teeArmed = true
  // Several exits, ONE write (idempotent): signal-time writers dump the
  // instant a termination signal lands (PTY drivers hard-kill 1.5s after
  // SIGTERM — the graceful pipeline can take longer than that); the cleanup
  // registry covers graceful shutdown; the sync 'exit' hook covers
  // forceExit()/process.exit(). Extra signal listeners are safe here — the
  // app already installs SIGTERM/SIGHUP handlers, so default-termination
  // semantics are unchanged.
  process.once('SIGTERM', () => writeProbeTee(path))
  process.once('SIGHUP', () => writeProbeTee(path))
  registerCleanup(async () => writeProbeTee(path))
  process.on('exit', () => writeProbeTee(path))
}

// 8192: an app-scale scene (the region matrix's 13 s stream) stamps per-delta
// tail marks, per-compose follow marks and, with the render-reason probe
// below, one mark per moved input per region render — the 2048 ring
// overflowed inside the measured window and the reader saw a truncated
// front. Bounded memory either way (fixed-capacity ring of small records).
const RING_CAP = 8192

export type FluxMark = { t: number; k: string; v: number }

const marks: FluxMark[] = []
let markAt = 0
const counters = new Map<string, number>()
const frameDur: number[] = []
let frameAt = 0
let framesTotal = 0
let longestFrameMs = 0

/** Increment a named monotonic counter (deltas, commits, coalesced, urgent,
 *  stale-dropped, patches, …). */
export function fluxCount(k: string, by = 1): void {
  if (!fluxProbeEnabled()) return
  counters.set(k, (counters.get(k) ?? 0) + by)
}

/** Record a point event with an optional numeric payload (latency spans are
 *  recorded as a mark whose v is the span in ms — correlation happens in the
 *  reader, not on the hot path). */
export function fluxMark(k: string, v = 0): void {
  if (!fluxProbeEnabled()) return
  const m: FluxMark = { t: performance.now(), k, v }
  if (marks.length < RING_CAP) marks.push(m)
  else {
    marks[markAt] = m
    markAt = (markAt + 1) % RING_CAP
  }
}

/** The render-reason probe (the region-invalidation hunt): a region's render
 *  function hands over a thunk of the inputs it renders from (store
 *  snapshots, props, context reads); the probe compares each key against
 *  the previous render's value by identity and stamps one mark per moved
 *  key — `why:<region>:<key>` — or `why:<region>:none` when nothing watched
 *  moved (a local state set, a parent re-render, a context the thunk does
 *  not list) and `why:<region>:mount` on the first render. The reader
 *  (scripts/streaming) correlates these against the `render:<region>`
 *  marks to name the subscription that broke a region's idle rhythm. Off
 *  ⇒ the latched-boolean check alone: the thunk never runs, the ref never
 *  fills, no allocation. The `prev` holder is the caller's own useRef. */
export function fluxWhy(
  region: string,
  prev: { current: Record<string, unknown> | null },
  read: () => Record<string, unknown>,
): void {
  if (!fluxProbeEnabled()) return
  const next = read()
  const before = prev.current
  prev.current = next
  if (before === null) {
    fluxMark(`why:${region}:mount`)
    return
  }
  let moved = 0
  for (const key of Object.keys(next)) {
    if (!Object.is(next[key], before[key])) {
      fluxMark(`why:${region}:${key}`)
      moved++
    }
  }
  if (moved === 0) fluxMark(`why:${region}:none`)
}

/** Record one rendered frame: wall duration + emitted patch count. Called
 *  from the ONE onRender tail — a frame is a frame, whatever scheduled it. */
export function fluxFrame(durationMs: number, patches: number): void {
  if (!fluxProbeEnabled()) return
  framesTotal++
  if (durationMs > longestFrameMs) longestFrameMs = durationMs
  if (frameDur.length < RING_CAP) frameDur.push(durationMs)
  else {
    frameDur[frameAt] = durationMs
    frameAt = (frameAt + 1) % RING_CAP
  }
  if (patches > 0) fluxCount('patches', patches)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

export type FluxSummary = {
  enabled: boolean
  counters: Record<string, number>
  frames: { total: number; window: number; p50: number; p95: number; p99: number; maxMs: number }
  /** The most recent marks, oldest-first (bounded copy for diagnostics). */
  recentMarks: FluxMark[]
}

/** Bounded snapshot for /doctor + benches. Percentiles are over the ring
 *  window (last ≤2048 frames), total/max over the whole session. */
export function fluxSummary(): FluxSummary {
  const sorted = [...frameDur].sort((a, b) => a - b)
  const recent =
    marks.length < RING_CAP ? [...marks] : [...marks.slice(markAt), ...marks.slice(0, markAt)]
  return {
    enabled: fluxProbeEnabled(),
    counters: Object.fromEntries(counters),
    frames: {
      total: framesTotal,
      window: frameDur.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      maxMs: longestFrameMs,
    },
    recentMarks: recent.slice(-64),
  }
}

export type FluxProbeDump = FluxSummary & {
  /** ALL ring marks oldest-first (recentMarks is the bounded 64-slice). */
  allMarks: FluxMark[]
  /** Date.now() − performance.now() at dump time: mark epoch ≈ t + offset. */
  epochMinusPerfNow: number
}

/** Full-state snapshot for the probe tee (out-of-process windowed readers). */
export function fluxProbeDump(): FluxProbeDump {
  const all =
    marks.length < RING_CAP ? [...marks] : [...marks.slice(markAt), ...marks.slice(0, markAt)]
  return {
    ...fluxSummary(),
    allMarks: all,
    epochMinusPerfNow: Date.now() - performance.now(),
  }
}

/** Test/bench seam: clear aggregates and re-latch the gate on next read. */
export function __fluxProbeResetForTest(): void {
  latched = null
  marks.length = 0
  markAt = 0
  counters.clear()
  frameDur.length = 0
  frameAt = 0
  framesTotal = 0
  longestFrameMs = 0
}
