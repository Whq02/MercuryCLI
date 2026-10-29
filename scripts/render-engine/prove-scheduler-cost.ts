#!/usr/bin/env bun

import { CADENCE_MS, COST_FLOOR_CAP_MS, PaintScheduler } from '../../src/render-engine/scheduler.js'
import { check, FakeClock, finish, section } from './harness.js'

function rig(costOf: (kind: string) => number): {
  clock: FakeClock
  sched: PaintScheduler
  paints: { at: number; kind: string }[]
} {
  const clock = new FakeClock()
  const paints: { at: number; kind: string }[] = []
  const sched = new PaintScheduler({
    paint: kind => {
      paints.push({ at: clock.now(), kind })
      return costOf(kind)
    },
    owedBytes: () => 0,
    clock,
  })
  return { clock, sched, paints }
}

section('§1 demand-driven')
{
  const { clock, paints } = rig(() => 1)
  clock.advance(5000)
  check('no requests ⇒ zero paints', paints.length === 0)
}

section('§2 cadence under a sustained burst')
{
  const { clock, sched, paints } = rig(() => 1)
  for (let i = 0; i < 200; i++) {
    sched.request()
    clock.advance(2)
  }
  clock.advance(100)
  check(
    `one paint per cadence window (${paints.length} paints in 400ms burst)`,
    paints.length >= 20 && paints.length <= 27,
  )
  let minGap = Infinity
  for (let i = 1; i < paints.length; i++) minGap = Math.min(minGap, paints[i]!.at - paints[i - 1]!.at)
  check(`no two paints inside one window (min gap ${minGap}ms ≥ ${CADENCE_MS})`, minGap >= CADENCE_MS)
}

section('§3 the adaptive floor')
{
  const { clock, sched, paints } = rig(() => 60)
  for (let i = 0; i < 100; i++) {
    sched.request()
    clock.advance(10)
  }
  clock.advance(300)
  let minGap = Infinity
  for (let i = 2; i < paints.length; i++) minGap = Math.min(minGap, paints[i]!.at - paints[i - 1]!.at)
  check(`heavy frames space to 2×C (min gap ${minGap}ms ≥ 120)`, paints.length >= 3 && minGap >= 120)

  const heavy = rig(() => 500)
  for (let i = 0; i < 100; i++) {
    heavy.sched.request()
    heavy.clock.advance(10)
  }
  heavy.clock.advance(400)
  let gaps: number[] = []
  for (let i = 2; i < heavy.paints.length; i++)
    gaps.push(heavy.paints[i]!.at - heavy.paints[i - 1]!.at)
  check(
    `the floor caps at ${COST_FLOOR_CAP_MS}ms (gaps ${gaps.slice(0, 3).join(',')})`,
    heavy.paints.length >= 3 && gaps.every(g => g >= COST_FLOOR_CAP_MS && g <= COST_FLOOR_CAP_MS + CADENCE_MS + 5),
  )
}

section('§4 input priority')
{
  const { clock, sched, paints } = rig(kind => (kind === 'input' ? 1 : 80))
  sched.request()
  clock.advance(1)
  const heavyAt = paints[0]?.at ?? -1
  sched.request()
  clock.advance(20)
  sched.requestInput()
  clock.advance(20)
  const inputPaint = paints.find(p => p.at > heavyAt)
  check('a keystroke paints on plain cadence while the floor holds', inputPaint !== undefined && inputPaint.at <= heavyAt + 45)
  clock.advance(400)
  check('the combined paint served every demand (none parked)', !sched.hasPending())
  check('no ghost paint followed', paints.length === 2)
}

finish()
