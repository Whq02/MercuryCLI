#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-scheduler-gates.ts — the ink scheduler
//  under the engine's gates (E5 cost floor · E6 choke · the keystroke lane),
//  clock-driven, and the flag-off identity.
//
//  S0  NO MOUNT: the scheduler's classic lattice is untouched — a request
//      paints on the leading edge, bursts collapse to one trailing paint
//      per 16ms window (byte-identical flag-off law).
//  S1  CHOKE (E6): while the mount reports owed > high water, a request
//      COMPOSES NOTHING — the demand survives as a 10ms retry and exactly
//      one paint lands after the drain. Deferrals are counted.
//  S2  FLOOR (E5): after a paint costing C, a normal request waits
//      max(cadence, 2×C) (cap 200ms) — the trailing edge lands at the
//      floor, not the cadence. Deferrals are counted.
//  S3  KEYSTROKE LANE (E5): with the floor holding heavy content back, an
//      input-latched request paints on the PLAIN cadence.
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-scheduler-gates.ts
// ============================================================================
import { RenderScheduler, type SchedulerClock } from '../../src/ink/root/render-scheduler.ts'
import {
  installCockpitEngineForTest,
  type CockpitEngine,
} from '../../src/render-engine/cockpit/engineMount.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// ── the deterministic clock ────────────────────────────────────────────────
type Timer = { at: number; fn: () => void; id: number }
class TestClock implements SchedulerClock {
  t = 1_000
  private timers: Timer[] = []
  private micro: Array<() => void> = []
  private nextId = 1
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer: Timer = { at: this.t + Math.max(0, ms), fn, id: this.nextId++ }
    this.timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout = (t: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter(x => x !== (t as unknown as Timer))
  }
  queueMicrotask = (fn: () => void): void => {
    this.micro.push(fn)
  }
  /** Drain microtasks, then advance to each due timer in order. */
  run(untilMs: number): void {
    const end = this.t + untilMs
    for (;;) {
      while (this.micro.length > 0) this.micro.shift()!()
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter(x => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    while (this.micro.length > 0) this.micro.shift()!()
    this.t = end
  }
}

// ── the synthetic mount ────────────────────────────────────────────────────
function syntheticEngine(state: { owed: number; lastCost: number; latch: boolean }): CockpitEngine {
  const counters = { choke: 0, floor: 0 }
  return {
    choked: () => state.owed > 256 * 1024,
    floorMs: () => Math.max(16, Math.min(2 * state.lastCost, 200)),
    notePaintCost: ms => {
      state.lastCost = ms
    },
    noteKeystroke: () => {
      state.latch = true
    },
    consumeInputPriority: () => {
      const was = state.latch
      state.latch = false
      return was
    },
    noteDeferral: kind => {
      if (kind === 'choke') counters.choke++
      else counters.floor++
    },
    armResize: () => {},
    winch: () => false,
    inResizeStorm: () => false,
    ledger: null as never,
    fold: null as never,
    streamBody: null as never,
    noteOverlay: () => {},
    metrics: () => ({ chokeDeferrals: counters.choke, floorDeferrals: counters.floor }) as never,
    detach: () => {},
  }
}

console.log('scheduler gates under the engine mount')

// ── S0: flag-off identity ──────────────────────────────────────────────────
{
  installCockpitEngineForTest(null)
  const clock = new TestClock()
  let paints = 0
  const s = new RenderScheduler(() => paints++, clock)
  clock.run(150) // past boot coalesce
  s.requestFrame()
  clock.run(1)
  check('S0 no mount: leading edge paints immediately', paints === 1, String(paints))
  s.requestFrame()
  s.requestFrame()
  s.requestFrame()
  clock.run(20)
  check('S0 no mount: a burst collapses to ONE trailing paint in the 16ms window', paints === 2, String(paints))
  s.cancel()
}

// ── S1: choke ──────────────────────────────────────────────────────────────
{
  const state = { owed: 999_999, lastCost: 0, latch: false }
  const engine = syntheticEngine(state)
  installCockpitEngineForTest(engine)
  const clock = new TestClock()
  let paints = 0
  const s = new RenderScheduler(() => paints++, clock)
  clock.run(150)
  s.requestFrame()
  clock.run(40) // several choke-retry rounds
  check('S1 choked: zero compositions while owed > high water', paints === 0, String(paints))
  const deferrals = (engine.metrics() as { chokeDeferrals: number }).chokeDeferrals
  check('S1 choke deferrals counted', deferrals >= 1, String(deferrals))
  state.owed = 0
  clock.run(20)
  check('S1 drained: exactly ONE fresh paint lands', paints === 1, String(paints))
  s.cancel()
  installCockpitEngineForTest(null)
}

// ── S2: the adaptive floor ─────────────────────────────────────────────────
{
  const state = { owed: 0, lastCost: 60, latch: false } // floor = 120ms
  installCockpitEngineForTest(syntheticEngine(state))
  const clock = new TestClock()
  let paints = 0
  const paintTimes: number[] = []
  const s = new RenderScheduler(() => {
    paints++
    paintTimes.push(clock.t)
  }, clock)
  clock.run(150)
  s.requestFrame()
  clock.run(1)
  check('S2 first paint lands on the leading edge', paints === 1)
  s.requestFrame() // inside the floor window
  clock.run(40)
  check('S2 a request inside the floor does NOT paint at the 16ms cadence', paints === 1, String(paints))
  clock.run(100)
  check('S2 the trailing paint lands at the floor boundary (~120ms)', paints === 2 && paintTimes[1]! - paintTimes[0]! >= 120, JSON.stringify(paintTimes))
  s.cancel()
  installCockpitEngineForTest(null)
}

// ── S3: the keystroke lane ─────────────────────────────────────────────────
{
  const state = { owed: 0, lastCost: 60, latch: false } // floor = 120ms
  const engine = syntheticEngine(state)
  installCockpitEngineForTest(engine)
  const clock = new TestClock()
  let paints = 0
  const paintTimes: number[] = []
  const s = new RenderScheduler(() => {
    paints++
    paintTimes.push(clock.t)
  }, clock)
  clock.run(150)
  s.requestFrame()
  clock.run(1)
  check('S3 first paint lands', paints === 1)
  engine.noteKeystroke()
  s.requestFrame() // the keystroke's own commit
  clock.run(20)
  check('S3 the input-latched request paints on the PLAIN cadence (≤16ms), floor bypassed', paints === 2 && paintTimes[1]! - paintTimes[0]! <= 17, JSON.stringify(paintTimes))
  s.cancel()
  installCockpitEngineForTest(null)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
