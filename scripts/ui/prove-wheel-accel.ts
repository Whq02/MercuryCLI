#!/usr/bin/env bun
import {
  computeWheelStep,
  initWheelAccel,
} from '../../src/components/ScrollKeybindingHandler.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}

console.log('prove-wheel-accel — discrete-notch cadence engages the curve')

{
  const s = initWheelAccel()
  const rows: number[] = []
  let t = 1_000
  for (let i = 0; i < 8; i++) {
    rows.push(computeWheelStep(s, 1, t))
    t += 100
  }
  check('first notches are gentle (1 row)', rows[0] === 1 && rows[1] === 1, JSON.stringify(rows))
  check('cadence engages the curve by notch 4 (≥2 rows)', rows[3]! >= 2, JSON.stringify(rows))
  check('sustained cadence keeps accelerating (notch 6 > notch 4)', rows[5]! >= rows[3]!, JSON.stringify(rows))
  check('wheelMode engaged without any encoder bounce', s.wheelMode === true)
}

{
  const s = initWheelAccel()
  let t = 1_000
  for (let i = 0; i < 20; i++) {
    computeWheelStep(s, 1, t)
    t += 16
  }
  check('16ms trackpad stream never cadence-engages wheelMode', s.wheelMode === false)
}

{
  const s = initWheelAccel()
  const rows: number[] = []
  let t = 1_000
  for (let i = 0; i < 5; i++) {
    rows.push(computeWheelStep(s, 1, t))
    t += 600
  }
  check('600ms-spaced clicks never accelerate', rows.every(r => r === 1), JSON.stringify(rows))
}

{
  const s = initWheelAccel()
  let t = 1_000
  computeWheelStep(s, 1, t); t += 100
  computeWheelStep(s, 1, t); t += 100
  computeWheelStep(s, -1, t); t += 100
  computeWheelStep(s, -1, t); t += 100
  check('reversal resets the cadence run (no engage from mixed directions)', s.wheelMode === false)
  computeWheelStep(s, -1, t); t += 100
  computeWheelStep(s, -1, t); t += 100
  computeWheelStep(s, -1, t)
  check('fresh post-reversal cadence run engages again', s.wheelMode === true)
}

{
  const s = initWheelAccel()
  let t = 1_000
  for (let i = 0; i < 4; i++) {
    computeWheelStep(s, 1, t)
    t += 100
  }
  check('(setup) engaged', s.wheelMode === true)
  for (let i = 0; i < 6; i++) {
    computeWheelStep(s, 1, t)
    t += 2
  }
  check('a <5ms burst run disengages (device switch honored)', s.wheelMode === false)
}

console.log(fail === 0 ? '\n✅ prove-wheel-accel: ALL PASS' : `\n❌ prove-wheel-accel: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
