#!/usr/bin/env bun
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

const POLL_MS = 80

let t = 0
setPulseClockForTests(() => t)

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

{
  resetPulseForTests()
  t = 0
  const g = beginPulseTurn()
  const poll = makeView()
  const seen = new Set<TurnPhaseName>()
  seen.add(poll(0))
  t = 100
  setPulsePhase(g, 'preparing', { reason: 'context' })
  seen.add(poll(100))
  seen.add(poll(160))
  t = 180
  setPulsePhase(g, 'dispatching')
  seen.add(poll(180))
  check('an 80ms preparing blip never displays', !seen.has('preparing'), [...seen].join(','))
  check('the held label during the blip is the coarse entry phase', seen.has('accepted'))
}

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
    poll(enter)
    let firstShown = -1
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
  const poll = makeView(true)
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
