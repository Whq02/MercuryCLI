#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/spinner/prove-display-dwell.ts — view law:
//  dwell/hysteresis over the spinner's ACTUAL consumption (nextDisplayedPhase
//  polled on the row's clock cadence).
//
//    · an 80ms preparing blip NEVER displays;
//    · a 300ms preparing subphase DOES display;
//    · a subphase that survives dwell becomes visible within 100ms of dwell
//      expiry (the row's FOCAL 80ms dwell slice — proved for every phase
//      alignment against the poll grid);
//    · non-detail phases (waiting/thinking/…) display instantly;
//    · reduced motion shows every phase instantly (dwell is animation-only).
//
//  Run: ~/.bun/bin/bun run scripts/pulse/spinner/prove-display-dwell.ts
// ============================================================================
import {
  beginPulseTurn,
  getPulsePhase,
  resetPulseForTests,
  setPulseClockForTests,
  setPulsePhase,
  type TurnPhaseName,
} from '../../../src/utils/pulse/index.js'
import {
  nextDisplayedPhase,
  PHASE_DWELL_MS,
} from '../../../src/components/Spinner/pulseByline.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.PULSE_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const POLL_MS = 80 // the row's FOCAL dwell slice cadence

let t = 0
setPulseClockForTests(() => t)

/** A view harness matching the row's consumption: polls carry the previous
 *  DISPLAYED phase forward, generation-aware. */
function makeView(reducedMotion = false) {
  let prev: { generation: number; phase: TurnPhaseName } = { generation: 0, phase: 'idle' }
  return (now: number): TurnPhaseName => {
    t = now
    const snap = getPulsePhase()
    const displayed = nextDisplayedPhase(prev, snap, now, reducedMotion)
    prev = { generation: snap.generation, phase: displayed }
    return displayed
  }
}

// ── an 80ms preparing blip never displays ───────────────────────────────────
{
  resetPulseForTests()
  t = 0
  const g = beginPulseTurn()
  const poll = makeView()
  const seen = new Set<TurnPhaseName>()
  seen.add(poll(0))
  t = 100
  setPulsePhase(g, 'preparing', { reason: 'context' })
  seen.add(poll(100)) // the transition's own render
  seen.add(poll(160))
  t = 180 // 80ms after entry — the blip ends
  setPulsePhase(g, 'dispatching')
  seen.add(poll(180))
  check('an 80ms preparing blip never displays', !seen.has('preparing'), [...seen].join(','))
  check('the held label during the blip is the coarse entry phase', seen.has('accepted'))
}

// ── a 300ms preparing subphase displays ─────────────────────────────────────
{
  resetPulseForTests()
  t = 0
  const g = beginPulseTurn()
  const poll = makeView()
  poll(0)
  t = 1000
  setPulsePhase(g, 'preparing', { reason: 'context' })
  const shownAt: number[] = []
  for (let now = 1000; now <= 1300; now += POLL_MS) {
    if (poll(now) === 'preparing') shownAt.push(now)
  }
  check('a 300ms preparing subphase displays', shownAt.length > 0)
  check(
    'never before the dwell threshold',
    shownAt.every(n => n - 1000 >= PHASE_DWELL_MS),
    shownAt.join(','),
  )
  check(
    `visible within 100ms of dwell expiry (first at +${(shownAt[0] ?? NaN) - 1000}ms)`,
    shownAt.length > 0 && shownAt[0]! - (1000 + PHASE_DWELL_MS) <= 100,
  )
}

// ── the 100ms visibility law holds for EVERY phase alignment ────────────────
{
  let worst = 0
  for (let offset = 0; offset < POLL_MS; offset++) {
    resetPulseForTests()
    t = 0
    const g = beginPulseTurn()
    const poll = makeView()
    poll(0)
    const enter = 2000 + offset
    t = enter
    setPulsePhase(g, 'preparing', { reason: 'workspace' })
    poll(enter) // the transition render
    let firstShown = -1
    // Poll on the absolute 80ms grid, exactly like the FOCAL dwell slice.
    for (let now = Math.ceil(enter / POLL_MS) * POLL_MS; now <= enter + 600; now += POLL_MS) {
      if (poll(now) === 'preparing') {
        firstShown = now
        break
      }
    }
    check(`offset ${offset}: subphase eventually displays`, firstShown >= 0)
    if (firstShown >= 0) worst = Math.max(worst, firstShown - (enter + PHASE_DWELL_MS))
  }
  check(
    `worst-case visibility lag after dwell expiry ≤ 100ms (measured ${worst}ms)`,
    worst <= 100,
  )
}

// ── non-detail phases display instantly; reduced motion skips dwell ─────────
{
  resetPulseForTests()
  t = 0
  const g = beginPulseTurn()
  const poll = makeView()
  poll(0)
  t = 50
  setPulsePhase(g, 'dispatching')
  setPulsePhase(g, 'waiting', { model: 'Fable 5' })
  check('waiting (non-detail) displays instantly', poll(50) === 'waiting')
  t = 51
  setPulsePhase(g, 'thinking')
  check('thinking displays instantly', poll(51) === 'thinking')
}
{
  resetPulseForTests()
  t = 0
  const g = beginPulseTurn()
  const poll = makeView(true) // reduced motion
  t = 10
  setPulsePhase(g, 'preparing', { reason: 'hooks' })
  check('reduced motion: preparing displays instantly (no dwell dependence)', poll(10) === 'preparing')
}

setPulseClockForTests(null)
resetPulseForTests()
if (failures > 0) {
  console.log(`\n❌ prove-display-dwell: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ display-dwell — blips suppressed, survivors visible ≤100ms past dwell')
