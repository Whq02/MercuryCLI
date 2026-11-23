import assert from 'node:assert/strict'
import { RenderScheduler, type SchedulerClock } from '../../src/screen/renderer/root/render-scheduler.ts'
import { FRAME_INTERVAL_MS } from '../../src/screen/renderer/constants.ts'

type Timer = { due: number; run: () => void }
let now = 1000
let timers: Timer[] = []
let microtasks: Array<() => void> = []
const clock: SchedulerClock = {
  now: () => now,
  setTimeout: (run, ms) => {
    const timer = { due: now + ms, run }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  },
  clearTimeout: timer => { timers = timers.filter(value => value !== timer as unknown as Timer) },
  queueMicrotask: run => { microtasks.push(run) },
}
function advance(ms: number): void {
  const end = now + ms
  for (;;) {
    while (microtasks.length) microtasks.shift()!()
    const due = timers.filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0]
    if (!due) break
    timers = timers.filter(timer => timer !== due)
    now = due.due
    due.run()
  }
  now = end
}

assert.equal(FRAME_INTERVAL_MS, 16, 'FRAME_INTERVAL_MS in src/screen/renderer/constants.ts is no longer 16; restore it or update this proof and the cadence it asserts')
let paints = 0
let content = 'initial'
const frames: string[] = []
const scheduler = new RenderScheduler(() => { paints++; frames.push(content) }, clock)
advance(150)
scheduler.requestFrame()
content = 'latest key state'
scheduler.requestFrame()
scheduler.requestFrame()
advance(0)
assert.equal(paints, 1, 'same-tick requestFrame calls must paint exactly once; fix the leading microtask in RenderScheduler.requestFrame (src/screen/renderer/root/render-scheduler.ts)')
assert.deepEqual(frames, ['latest key state'], 'the leading paint must draw the content current when the microtask runs; fix RenderScheduler.requestFrame (src/screen/renderer/root/render-scheduler.ts)')
advance(FRAME_INTERVAL_MS)
assert.equal(paints, 1, 'FAIL commits covered by the queued leading frame must not arm an empty settle frame; fix RenderScheduler.requestFrame in src/screen/renderer/root/render-scheduler.ts')
console.log('PASS a queued leading frame absorbs same-tick commits without a redundant settle frame')

scheduler.requestFrame()
advance(0)
scheduler.requestFrame()
advance(FRAME_INTERVAL_MS - 1)
assert.equal(paints, 2, 'a commit after the leading paint must wait for the 16 ms interval, so paints should be 2 here; fix the trailing timer in RenderScheduler.requestFrame (src/screen/renderer/root/render-scheduler.ts)')
advance(1)
assert.equal(paints, 3, 'the coalesced frame must paint once the 16 ms interval ends; fix the trailing timer in RenderScheduler.requestFrame (src/screen/renderer/root/render-scheduler.ts)')
console.log('PASS commits after the leading paint still coalesce at the unchanged 16 ms cadence')

advance(FRAME_INTERVAL_MS)
scheduler.requestFrame()
scheduler.cancel()
advance(0)
assert.equal(paints, 3, 'RenderScheduler.cancel must drop an armed leading microtask so no paint follows; fix cancel and the microtask guard in src/screen/renderer/root/render-scheduler.ts')
console.log('PASS cancelling an armed microtask does not paint a detached screen')

scheduler.requestFrame()
scheduler.holdForSettle()
advance(0)
assert.equal(paints, 3, 'holdForSettle must also gate an already queued leading microtask; fix holdForSettle and the microtask guard in src/screen/renderer/root/render-scheduler.ts')
scheduler.releaseSettleHold(true)
advance(FRAME_INTERVAL_MS)
assert.equal(paints, 4, 'releaseSettleHold(true) must flush the held frame within one interval; fix releaseSettleHold in src/screen/renderer/root/render-scheduler.ts')
console.log('PASS resize hold also gates the already queued leading microtask')
scheduler.cancel()
const bootFrames: number[] = []
const bootScheduler = new RenderScheduler(() => {
  bootScheduler.onRenderEntry()
  bootFrames.push(now)
}, clock)
bootScheduler.requestFrame()
now += 100
bootScheduler.requestFrame()
advance(0)
assert.equal(bootFrames.length, 1, 'FAIL a leading paint must absorb a due but undelivered boot timer; fix RenderScheduler.onRenderEntry and requestFrame in src/screen/renderer/root/render-scheduler.ts')
bootScheduler.cancel()
console.log('PASS a leading paint consumes an overdue boot timer without a duplicate frame')

let probeOutstanding = true
const probeFrames: number[] = []
const probeScheduler = new RenderScheduler(() => {
  probeScheduler.onRenderEntry()
  probeFrames.push(now)
}, clock, () => probeOutstanding)
probeScheduler.requestFrame()
advance(100)
assert.equal(probeFrames.length, 0, 'no frame may paint while the capability probe is outstanding; fix the probe gate (third constructor argument) in RenderScheduler, src/screen/renderer/root/render-scheduler.ts')
advance(1)
probeOutstanding = false
probeScheduler.requestFrame()
advance(0)
assert.equal(probeFrames.length, 1, 'a commit after the probe settles must paint one leading frame; fix RenderScheduler.requestFrame in src/screen/renderer/root/render-scheduler.ts')
advance(15)
assert.equal(probeFrames.length, 1, 'FAIL a first paint released by a commit must absorb its pending probe retry; fix RenderScheduler.onRenderEntry in src/screen/renderer/root/render-scheduler.ts')
probeScheduler.cancel()
console.log('PASS the first paint consumes a pending capability-probe retry without a duplicate frame')

console.log('INPUT LEADING RENDER HOLDS')
