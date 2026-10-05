import assert from 'node:assert/strict'
import { RenderScheduler, type SchedulerClock } from '../../src/ink/root/render-scheduler.ts'
import { FRAME_INTERVAL_MS } from '../../src/ink/constants.ts'

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

assert.equal(FRAME_INTERVAL_MS, 16)
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
assert.equal(paints, 1)
assert.deepEqual(frames, ['latest key state'])
advance(FRAME_INTERVAL_MS)
assert.equal(paints, 1, 'FAIL commits covered by the queued leading frame must not arm an empty settle frame')
console.log('PASS a queued leading frame absorbs same-tick commits without a redundant settle frame')

scheduler.requestFrame()
advance(0)
scheduler.requestFrame()
advance(FRAME_INTERVAL_MS - 1)
assert.equal(paints, 2)
advance(1)
assert.equal(paints, 3)
console.log('PASS commits after the leading paint still coalesce at the unchanged 16 ms cadence')

advance(FRAME_INTERVAL_MS)
scheduler.requestFrame()
scheduler.cancel()
advance(0)
assert.equal(paints, 3)
console.log('PASS cancelling an armed microtask does not paint a detached screen')

scheduler.requestFrame()
scheduler.holdForSettle()
advance(0)
assert.equal(paints, 3)
scheduler.releaseSettleHold(true)
advance(FRAME_INTERVAL_MS)
assert.equal(paints, 4)
console.log('PASS resize hold also gates the already queued leading microtask')
scheduler.cancel()
console.log('INPUT LEADING RENDER HOLDS')
