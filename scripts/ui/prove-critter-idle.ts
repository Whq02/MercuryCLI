#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import {
  BLINK_CYCLE,
  BREATH_BUCKETS,
  BREATH_PERIOD,
  BREATH_TICK_MS,
  breathBucket,
  breathWave,
  critterIdleEnabled,
  EYE_OPEN,
  EYE_SHUT,
  IDLE_TICK_MS,
  LID_MS,
  pupilForTime,
  SECOND_LID_AT,
} from '../../src/utils/cockpit/critterIdle.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const setStamp = (on: boolean) =>
  ((globalThis as Record<string, unknown>)['MACRO'] = { VERSION: on ? '1.0.0' : '0.0.0-src' })

console.log('============================================================')
console.log(' critter-idle — living-splash timing + gate (render-free)')
console.log('============================================================')

section('blink SCHEDULE — lid shut only in its brief windows')
check('phase 0 → lid SHUT', pupilForTime(0) === EYE_SHUT)
check('phase just inside lid → SHUT', pupilForTime(LID_MS - 10) === EYE_SHUT)
check('phase past the lid → OPEN', pupilForTime(LID_MS + 10) === EYE_OPEN)
check('mid-cycle → OPEN (forward gaze)', pupilForTime(BLINK_CYCLE / 2) === EYE_OPEN)
check('end of cycle → OPEN', pupilForTime(BLINK_CYCLE - 1) === EYE_OPEN)
check(
  'plain cycle: no second blink at SECOND_LID_AT',
  pupilForTime(SECOND_LID_AT + 10) === EYE_OPEN,
)
const c3 = BLINK_CYCLE * 3
check('4th cycle: first lid SHUT', pupilForTime(c3 + 10) === EYE_SHUT)
check('4th cycle: gap between lids OPEN', pupilForTime(c3 + (LID_MS + SECOND_LID_AT) / 2) === EYE_OPEN)
check('4th cycle: SECOND lid SHUT', pupilForTime(c3 + SECOND_LID_AT + 10) === EYE_SHUT)
let shut = 0
for (let t = 0; t < BLINK_CYCLE; t += 20) if (pupilForTime(t) === EYE_SHUT) shut++
const shutFrac = shut / (BLINK_CYCLE / 20)
check('lid shut < 10% of a plain cycle (calm, not a tic)', shutFrac < 0.1, `${(shutFrac * 100).toFixed(1)}%`)

section('breath WAVE — smooth, bounded 0→1→0')
let lo = Infinity
let hi = -Infinity
for (let t = 0; t < 2800; t += 25) {
  const w = breathWave(t)
  lo = Math.min(lo, w)
  hi = Math.max(hi, w)
}
check('wave stays within [0,1]', lo >= 0 && hi <= 1, `min ${lo.toFixed(3)} max ${hi.toFixed(3)}`)
check('wave actually breathes (spans most of the range)', hi - lo > 0.9, `span ${(hi - lo).toFixed(3)}`)
check('wave is continuous (no jump > 0.1 per tick)', (() => {
  let prev = breathWave(0)
  for (let t = 25; t < 2800; t += 25) {
    const w = breathWave(t)
    if (Math.abs(w - prev) > 0.1) return false
    prev = w
  }
  return true
})())

section('derived-value EDGE RATE — the idle home must not commit per tick')
const SIM_MS = 60_000
let pupilEdges = 0
let prevPupil = pupilForTime(0)
for (let t = IDLE_TICK_MS; t < SIM_MS; t += IDLE_TICK_MS) {
  const p = pupilForTime(t)
  if (p !== prevPupil) pupilEdges++
  prevPupil = p
}
const pupilRate = pupilEdges / (SIM_MS / 1000)
check('pupil edges ≤ 2/s (blink lids only)', pupilRate <= 2, `${pupilRate.toFixed(2)}/s`)
let bucketEdges = 0
let prevBucket = breathBucket(0)
for (let t = BREATH_TICK_MS; t < SIM_MS; t += BREATH_TICK_MS) {
  const b = breathBucket(t)
  if (b !== prevBucket) bucketEdges++
  prevBucket = b
}
const bucketRate = bucketEdges / (SIM_MS / 1000)
check('breath-bucket edges ≤ 6/s (quantized, below the raw tick rate)', bucketRate <= 6, `${bucketRate.toFixed(2)}/s`)
check(
  'breath buckets span the full range (still visibly breathes)',
  (() => {
    const seen = new Set<number>()
    for (let t = 0; t < BREATH_PERIOD; t += BREATH_TICK_MS) seen.add(breathBucket(t))
    return seen.has(0) && seen.has(BREATH_BUCKETS) && seen.size >= BREATH_BUCKETS - 1
  })(),
)

section('fork + env GATE (OFF ⇒ static fallback ⇒ byte-identical)')
setStamp(true)
delete process.env.MERCURY_CRITTER_IDLE
check('fork + no opt-out → idle ENABLED', critterIdleEnabled() === true)
process.env.MERCURY_CRITTER_IDLE = '0'
check('MERCURY_CRITTER_IDLE=0 → DISABLED (static)', critterIdleEnabled() === false)
delete process.env.MERCURY_CRITTER_IDLE
setStamp(false)
check('bare stamp → STILL enabled (stamp-independence)', critterIdleEnabled() === true)
setStamp(true)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CRITTER-IDLE PROOFS PASS')
else console.log(`❌ ${failures} CRITTER-IDLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
