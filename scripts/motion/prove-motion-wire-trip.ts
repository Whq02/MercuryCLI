#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as governor from '../../src/utils/cockpit/motionGovernor.js'
import { _resetFrameTraceForTesting, readFrameWire, recordFrameTrace } from '../../src/ink/root/frame-trace.js'
import { writeDiffToTerminal, type DeliverySyscalls } from '../../src/ink/session/delivery.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function finish(): never {
  console.log(`\n${failures === 0 ? '✅ motion wire trip GREEN' : `❌ motion wire trip RED — ${failures} failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' motion governor — the second trip signal: bytes on the wire')
console.log('============================================================')

section('W1 the second signal exists beside paint cost')
check('the governor takes the frame\'s wire note (noteFrameWire)', typeof governor.noteFrameWire === 'function', 'absent: the governor trips on paint cost alone')
check('the governor names what tripped it (governorTrip)', typeof governor.governorTrip === 'function', 'absent')
if (typeof governor.noteFrameWire !== 'function' || typeof governor.governorTrip !== 'function') finish()

const {
  __motionGovernorResetForTest,
  __setLoopMeterForTest,
  FRAME_BUDGET_MS,
  governorLevel,
  governorTrip,
  idleMotionLevel,
  idleMotionWord,
  motionGovernorFacts,
  noteFrameCost,
  noteFrameWire,
  reducedPeriodMs,
  REDUCED_FLOOR_MS,
  RELEASE_RUN,
  setMotionPosture,
  subscribeIdleMotion,
  TRIP_RUN,
  TRIP_RUN_COST_MS,
} = governor

const SLOW = Math.ceil(TRIP_RUN_COST_MS / TRIP_RUN) + 10
const MILD = FRAME_BUDGET_MS + 4
const FAST = 1
const CHEAP = FRAME_BUDGET_MS - 8
const OVER = SLOW
let seq = 0
function meter(share: number | null): void {
  __setLoopMeterForTest({ begin() {}, busyShare: () => share })
}
function reset(): void {
  __motionGovernorResetForTest()
  setMotionPosture('auto')
  meter(0)
}
function frame(drainMs: number | null, costMs = CHEAP, wireBytes = 15000): void {
  noteFrameWire({ seq: seq++, wireBytes, drainMs })
  noteFrameCost(costMs)
}
function frames(n: number, drainMs: number | null, costMs = CHEAP): void {
  for (let i = 0; i < n; i++) frame(drainMs, costMs)
}

section('W2 the trip: a run of slow drains drops auto to reduced, the loop idle')
reset()
let notices = 0
const unsub = subscribeIdleMotion(() => notices++)
check('boot: full, no trip, no word', governorLevel() === 'full' && governorTrip() === null && idleMotionWord() === null)
frames(TRIP_RUN - 1, SLOW)
check(`${TRIP_RUN - 1} frames draining in ${SLOW} ms (the loop idle): still full`, governorLevel() === 'full' && governorTrip() === null)
frame(SLOW)
check(`the ${TRIP_RUN}th slow drain trips REDUCED`, governorLevel() === 'reduced')
check('…and the governor names the wire', governorTrip() === 'wire', String(governorTrip()))
check('the status word is the same word the paint trip paints', idleMotionWord() === 'reduced')
check('every part reads reduced under auto', idleMotionLevel('critter') === 'reduced' && idleMotionLevel('glyphs') === 'reduced' && idleMotionLevel('clock') === 'reduced')
check('exactly one notice for the trip', notices === 1, `${notices}`)
check('the reduced cadence starts at the floor', reducedPeriodMs() === REDUCED_FLOOR_MS)
check('the facts carry the trip', motionGovernorFacts().trip === 'wire' && motionGovernorFacts().level === 'reduced')
unsub()

section('W3 the same gate: the run is measured in drain time too')
reset()
frames(TRIP_RUN * 2, MILD)
check(`${TRIP_RUN * 2} drains a shade over budget (${MILD} ms) never trip: the run's drain time is under the gate`, governorLevel() === 'full')
const mildRun = Math.ceil(TRIP_RUN_COST_MS / MILD)
reset()
frames(mildRun - 1, MILD)
check(`…until the run's drain time reaches the gate (${mildRun - 1} frames: still full)`, governorLevel() === 'full')
frame(MILD)
check(`…the ${mildRun}th mild drain trips the wire`, governorLevel() === 'reduced' && governorTrip() === 'wire')
reset()
frames(TRIP_RUN - 1, SLOW)
frame(FAST)
frames(TRIP_RUN - 1, SLOW)
check('one fast drain inside a slow run restarts the count', governorLevel() === 'full')
frame(SLOW)
check('…and a full run after it trips', governorLevel() === 'reduced' && governorTrip() === 'wire')
reset()
frames(TRIP_RUN - 1, SLOW)
frame(0, CHEAP, 0)
frames(TRIP_RUN - 1, SLOW)
check('a frame that wrote nothing (0 bytes, 0 ms) is a fast drain: it restarts the count too', governorLevel() === 'full')

section('W4 the attribution: the wire is judged before the paint')
reset()
frames(TRIP_RUN, SLOW, OVER)
check('frames over budget on BOTH signals (the terminal road\'s cost holds the drain) trip as the wire', governorLevel() === 'reduced' && governorTrip() === 'wire', String(governorTrip()))
reset()
meter(1)
frames(TRIP_RUN, FAST, OVER)
check('frames over budget on paint alone (fast drains, the loop busy) trip as paint', governorLevel() === 'reduced' && governorTrip() === 'paint', String(governorTrip()))
check('the status word is the same for both trips', idleMotionWord() === 'reduced')
reset()
meter(0)
frames(TRIP_RUN * 3, FAST, OVER)
check('paint alone with the loop idle still trips nothing (the paint confirmation stands)', governorLevel() === 'full')
frames(TRIP_RUN, SLOW, CHEAP)
check('…while the wire needs no loop confirmation: the link is the measurement', governorLevel() === 'reduced' && governorTrip() === 'wire')

section('W5 the release: the same longer run, judged on both signals')
reset()
frames(TRIP_RUN, SLOW)
check('reduced by the wire', governorTrip() === 'wire')
frames(RELEASE_RUN - 1, FAST)
check(`${RELEASE_RUN - 1} frames cheap on both signals: still reduced`, governorLevel() === 'reduced' && governorTrip() === 'wire')
frame(FAST)
check(`the ${RELEASE_RUN}th releases to FULL and the trip clears`, governorLevel() === 'full' && governorTrip() === null)
check('the word is gone after the release', idleMotionWord() === null)
reset()
frames(TRIP_RUN, SLOW)
frames(RELEASE_RUN - 8, FAST)
frame(SLOW, CHEAP)
frames(RELEASE_RUN - 1, FAST)
check('a slow drain under a cheap paint restarts the release run (the frame is judged whole)', governorLevel() === 'reduced')
frame(FAST)
check('…and the full run after it releases', governorLevel() === 'full')
reset()
meter(1)
frames(TRIP_RUN, FAST, OVER)
check('reduced by paint', governorTrip() === 'paint')
frames(RELEASE_RUN - 8, FAST)
frame(SLOW, CHEAP)
frames(RELEASE_RUN - 1, FAST)
check('a slow drain restarts the release run of a paint trip too', governorLevel() === 'reduced' && governorTrip() === 'paint')
frame(FAST)
check('…and releases after the full run', governorLevel() === 'full' && governorTrip() === null)
reset()
frames(TRIP_RUN, SLOW)
for (let i = 0; i < 200; i++) frame(i % 2 === 0 ? FRAME_BUDGET_MS - 1 : FRAME_BUDGET_MS + 1)
check('a drain hovering at the budget never releases (200 frames)', governorLevel() === 'reduced')
reset()
for (let i = 0; i < 200; i++) frame(i % 2 === 0 ? FRAME_BUDGET_MS - 1 : FRAME_BUDGET_MS + 1)
check('…and never trips from full', governorLevel() === 'full')

section('W6 an unknown drain carries no verdict')
reset()
frames(6, SLOW)
frames(3, null)
frames(6, SLOW)
check('a drain not yet marked (the door road, a stream still writing) neither extends nor breaks the run', governorLevel() === 'reduced' && governorTrip() === 'wire')
reset()
for (let i = 0; i < TRIP_RUN * 2; i++) {
  noteFrameWire({ seq: 7, wireBytes: 15000, drainMs: SLOW })
  noteFrameCost(CHEAP)
}
check('the same trace row read twice is judged once (a stale row never builds a run)', governorLevel() === 'full')
reset()
for (let i = 0; i < TRIP_RUN * 2; i++) {
  noteFrameWire(null)
  noteFrameCost(CHEAP)
}
check('no trace row at all (nothing filed): the paint law alone, as before', governorLevel() === 'full')
reset()
frames(TRIP_RUN, SLOW)
frames(RELEASE_RUN - 1, null, CHEAP)
check('unknown drains under cheap paints count toward the release as cheap frames', governorLevel() === 'reduced')
frame(null, CHEAP)
check('…and release on the run\'s last', governorLevel() === 'full')

section('W7 the postures: full, reduced and off behave as today')
reset()
frames(TRIP_RUN, SLOW)
setMotionPosture('full')
check('full never reduces: the governor says reduced by the wire, the level is full, no word', governorTrip() === 'wire' && idleMotionLevel('clock') === 'full' && idleMotionWord() === null)
setMotionPosture('reduced')
check('reduced stands on its own: the word shows whatever the governor says', idleMotionLevel('clock') === 'reduced' && idleMotionWord() === 'reduced')
setMotionPosture('off')
check('off stops every part, no word', idleMotionLevel('clock') === 'off' && idleMotionWord() === null)
setMotionPosture('auto')
check('auto reads the governor again (reduced by the wire)', idleMotionLevel('clock') === 'reduced' && governorTrip() === 'wire')

section('W8 through the seam: the terminal road with a kernel that takes the bytes slowly')
{
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
  const link = (spins: number, accepted: number[]): DeliverySyscalls => {
    let left = spins
    return {
      writeSync: (_fd, data, offset) => {
        if (left > 0) {
          left--
          throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' })
        }
        left = spins
        accepted.push(data.length - offset)
        return data.length - offset
      },
      sleep: ms => {
        Atomics.wait(sleepBuf, 0, 0, ms)
      },
    }
  }
  type Out = Parameters<typeof writeDiffToTerminal>[0]['stdout']
  const stdout = { isTTY: true, fd: 99, write: () => true } as unknown as Out
  const stderr = { write: () => true } as unknown as Out
  const body = '\u001b[2;1H' + 'x'.repeat(15000)
  const run = (spins: number, n: number): { drains: number[]; bytes: number[]; accepted: number[] } => {
    const drains: number[] = []
    const bytes: number[] = []
    const accepted: number[] = []
    const syscalls = link(spins, accepted)
    for (let i = 0; i < n; i++) {
      const delivered = writeDiffToTerminal({ stdout, stderr }, [{ type: 'stdout', content: body }], true, syscalls)
      recordFrameTrace({ durationMs: CHEAP, flickers: [] })
      const wire = readFrameWire()
      if (!delivered || wire === null) break
      drains.push(wire.drainMs ?? -1)
      bytes.push(wire.wireBytes)
      noteFrameWire(wire)
      noteFrameCost(CHEAP)
    }
    return { drains, bytes, accepted }
  }
  delete process.env.MERCURY_RENDER_ENGINE
  delete process.env.INK_WRITE_TEE
  reset()
  _resetFrameTraceForTesting()
  const slow = run(24, TRIP_RUN)
  check(`${TRIP_RUN} frames of ${slow.bytes[0]} bytes, the kernel refusing each 24 times (${(24 * 2.5).toFixed(0)} ms of waiting a frame): every drain over the budget`, slow.drains.length === TRIP_RUN && slow.drains.every(d => d > FRAME_BUDGET_MS), slow.drains.map(d => d.toFixed(1)).join(','))
  check('the wire bytes are the bytes the kernel accepted', slow.bytes.every((b, i) => b === slow.accepted[i] && b === Buffer.byteLength(body)), `${slow.bytes[0]} vs ${slow.accepted[0]}`)
  check('the governor dropped auto to reduced and named the wire', governorLevel() === 'reduced' && governorTrip() === 'wire' && idleMotionWord() === 'reduced', `${governorLevel()} ${String(governorTrip())}`)
  reset()
  _resetFrameTraceForTesting()
  const fast = run(0, TRIP_RUN * 2)
  check(`${TRIP_RUN * 2} frames the kernel takes at once: every drain under the budget`, fast.drains.length === TRIP_RUN * 2 && fast.drains.every(d => d >= 0 && d <= FRAME_BUDGET_MS), fast.drains.map(d => d.toFixed(2)).join(','))
  check('…and the governor stays full', governorLevel() === 'full' && governorTrip() === null)
  reset()
  _resetFrameTraceForTesting()
  run(24, TRIP_RUN)
  const release = run(0, RELEASE_RUN)
  check(`a link that recovers releases after ${RELEASE_RUN} fast frames`, release.drains.length === RELEASE_RUN && governorLevel() === 'full' && governorTrip() === null, `${governorLevel()} ${String(governorTrip())}`)
}

section('W9 the seams in the product')
{
  const ink = src('src/ink/ink.tsx')
  const wireAt = ink.indexOf('noteFrameWire(readFrameWire())')
  const costAt = ink.indexOf('noteFrameCost(durationMs)')
  const filedAt = ink.indexOf('this.options.onFrame?.(')
  check('the paint tail hands the governor the frame\'s wire row before its cost', wireAt > 0 && costAt > wireAt && ink.slice(wireAt, costAt).trim() === 'noteFrameWire(readFrameWire())', `${wireAt} ${costAt}`)
  check('…after the frame\'s row is filed (the trace consumer runs first)', filedAt > 0 && filedAt < wireAt, `${filedAt} ${wireAt}`)
  check('the paint tail burns the cost pad before the cost is measured', ink.indexOf('burnFrameCostPad()') < costAt && ink.indexOf('burnFrameCostPad()') > 0)
  const helpers = src('src/interactiveHelpers.tsx')
  check('the render context\'s onFrame files the trace row the governor reads', /recordFrameTrace\(\{/.test(helpers) && /onFrame\b/.test(helpers))
  const main = src('src/main.tsx')
  check('the product renders with that context', /getRenderContext\(/.test(main))
  const trace = src('src/ink/root/frame-trace.ts')
  check('the row carries the bytes on the wire and the drain (the seam)', /wireBytes: number/.test(trace) && /drainMs: number \| null/.test(trace) && /export function readFrameWire\(\)/.test(trace))
  const frame = src('src/components/MercuryFrame.tsx')
  check('the status line keeps the paint trip\'s word', /useIdleMotion\('clock'\)/.test(frame) && />reduced<\/Text>/.test(frame))
  check('…and names the slow link beside it under auto only', /motionAuto && governorTrip\(\) === 'wire' \? <Text[^>]*> · slow link<\/Text> : null/.test(frame) && /const motionAuto = motionPosture\(\) === 'auto'/.test(frame))
  const governorSrc = src('src/utils/cockpit/motionGovernor.ts')
  check('the governor is still config-free (flag reads only)', !/utils\/config/.test(governorSrc) && /flagRegistry/.test(governorSrc))
  check('the governor imports no engine module (the paint tail feeds it)', !/ink\/root|ink\/session/.test(governorSrc))
}
reset()
finish()
