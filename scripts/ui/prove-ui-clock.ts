#!/usr/bin/env bun
import { markScrollActivity } from '../../src/bootstrap/state.js'
import { _setUiClockMeterForProofs, lastClockTick, quantizedNow, subscribeUiClock, uiClockPostureForProofs, uiClockStatsForProofs } from '../../src/utils/cockpit/uiClock.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

console.log('prove-ui-clock')

let aTicks = 0
let bTicks = 0
const unsubA = subscribeUiClock(100, () => aTicks++)
const unsubB = subscribeUiClock(100, () => bTicks++)
const unsubC = subscribeUiClock(50, () => {})
{
  const stats = uiClockStatsForProofs()
  check('§1 same cadence shares ONE bucket', stats[100] === 2, `${JSON.stringify(stats)}; subscribeUiClock in src/utils/cockpit/uiClock.ts must keep one bucket per cadence`)
  check('§1 distinct cadences get distinct buckets', stats[50] === 1, `${JSON.stringify(stats)}; subscribeUiClock in src/utils/cockpit/uiClock.ts must open a separate bucket for each distinct cadence`)
}

await sleep(370)
check('§2 both subscribers ticked ~3× in 370ms @100ms', aTicks >= 2 && aTicks <= 5 && bTicks >= 2 && bTicks <= 5, `a=${aTicks} b=${bTicks}; the bucket timer in subscribeUiClock (src/utils/cockpit/uiClock.ts) must fan out to every subscriber each cadence`)
check('§2 subscribers of one bucket tick in lockstep', aTicks === bTicks, `a=${aTicks} b=${bTicks}; fanOut in src/utils/cockpit/uiClock.ts must call every subscriber of a bucket on each tick`)

check('§3 quantizedNow is cadence-aligned', quantizedNow(100) % 100 === 0, 'quantizedNow in src/utils/cockpit/uiClock.ts must floor Date.now() to a multiple of the cadence')

{
  const before = aTicks
  markScrollActivity()
  await sleep(120)
  check('§4 ticks are skipped during scroll drain', aTicks === before, `+${aTicks - before}; tick in src/utils/cockpit/uiClock.ts must skip fan-out while getIsScrollDraining() is true`)
  await sleep(250)
  check('§4 ticks resume after drain clears', aTicks > before, `+${aTicks - before}; tick in src/utils/cockpit/uiClock.ts must fan out again once the scroll drain clears`)
}

unsubA()
{
  const stats = uiClockStatsForProofs()
  check('§5 partial unsubscribe keeps the bucket', stats[100] === 1, `${JSON.stringify(stats)}; the unsubscribe returned by subscribeUiClock (src/utils/cockpit/uiClock.ts) must remove only its own callback and keep the bucket while others remain`)
}
unsubB()
unsubC()
{
  const stats = uiClockStatsForProofs()
  check('§5 zero buckets after last unsubscribe', Object.keys(stats).length === 0, `${JSON.stringify(stats)}; the unsubscribe returned by subscribeUiClock (src/utils/cockpit/uiClock.ts) must delete the bucket and stop its timer when the last subscriber leaves`)
}

{
  const unsub = subscribeUiClock(1000, () => {})
  const realNow = Date.now
  try {
    const aligned = Math.floor(realNow() / 1000) * 1000
    Date.now = () => aligned + 995
    const qa = quantizedNow(1000)
    const a = lastClockTick(1000)
    Date.now = () => aligned + 1005
    const qb = quantizedNow(1000)
    const b = lastClockTick(1000)
    check('§6 discriminator: raw quantizedNow DOES move across the boundary (the refuted one-liner would too)', qa !== qb, `${qa} vs ${qb}; the proof's fake Date.now no longer crosses a 1000 ms boundary, or quantizedNow in src/utils/cockpit/uiClock.ts stopped reading Date.now()`)
    check('§6 lastClockTick is Object.is-stable across a mid-render boundary crossing (no notification, no move)', a === b, `${a} vs ${b}; lastClockTick in src/utils/cockpit/uiClock.ts must return the stamp set by the last fanOut, not recompute from Date.now()`)
  } finally {
    Date.now = realNow
  }
  unsub()
}

{
  let ticks = 0
  const unsub = subscribeUiClock(100, () => ticks++)
  const start = lastClockTick(100)
  await sleep(250)
  check('§6b the stamp advances WITH notifications', ticks >= 1 && lastClockTick(100) > start, `ticks=${ticks}; fanOut in src/utils/cockpit/uiClock.ts must store the new quantizedNow stamp in lastTickByCadence on every notification`)
  markScrollActivity()
  const frozen = lastClockTick(100)
  await sleep(120)
  check('§6b the stamp never moves during scroll drain (no notify ⇒ no move)', lastClockTick(100) === frozen, `${frozen} vs ${lastClockTick(100)}; the scroll-drain skip in tick (src/utils/cockpit/uiClock.ts) must happen before fanOut updates the stamp`)
  await sleep(250)
  check('§6b …and resumes with the ticks after the drain clears', lastClockTick(100) > frozen, 'tick in src/utils/cockpit/uiClock.ts must resume fanOut, and so advance the stamp, after the scroll drain clears')
  unsub()
}


{
  const METER = { budgetMs: 4, probeMs: 1500 }
  const WINDOW_MS = 1000
  const DEGRADE_WINDOWS = 2
  const RECOVER_PROBES = 2
  _setUiClockMeterForProofs(METER)
  const untilPosture = async (want: boolean, boundMs: number): Promise<number> => {
    const t0 = performance.now()
    while (uiClockPostureForProofs()[50] !== want && performance.now() - t0 < boundMs) await sleep(25)
    return Math.round(performance.now() - t0)
  }
  let heavy = true
  let ticks = 0
  const spin = (ms: number): void => {
    const until = performance.now() + ms
    while (performance.now() < until) {
    }
  }
  const unsub = subscribeUiClock(50, () => {
    ticks++
    if (heavy) spin(2)
  })
  const degradedAfter = await untilPosture(true, (DEGRADE_WINDOWS + 1) * WINDOW_MS)
  const posture = uiClockPostureForProofs()
  check('§7 two over-budget windows degrade the bucket', posture[50] === true, `${JSON.stringify(posture)} after ${degradedAfter} ms; closeWindow in src/utils/cockpit/uiClock.ts must set degraded after DEGRADE_WINDOWS consecutive windows whose fan-out cost exceeds the budget`)
  const before = ticks
  await sleep(1000)
  const halved = ticks - before
  check('§7 a degraded bucket fans out at about half its cadence (every other tick skipped)', halved >= 6 && halved <= 15, `${halved} fan-outs in 1 s @50 ms; tick in src/utils/cockpit/uiClock.ts must skip every other tick while a bucket is degraded`)
  heavy = false
  const recoveredAfter = await untilPosture(false, (RECOVER_PROBES + 1) * (METER.probeMs + WINDOW_MS))
  const recovered = uiClockPostureForProofs()
  check('§7 two quiet probes restore the cadence', recovered[50] === false, `${JSON.stringify(recovered)} after ${recoveredAfter} ms; closeWindow in src/utils/cockpit/uiClock.ts must clear degraded after RECOVER_PROBES probe windows under half the budget`)
  unsub()
  _setUiClockMeterForProofs(null)
}

console.log(failures === 0 ? '\n✓ prove-ui-clock: all green' : `\n✗ prove-ui-clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
