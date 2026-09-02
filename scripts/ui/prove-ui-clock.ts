#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markScrollActivity } from '../../src/bootstrap/state.js'
import { lastClockTick, quantizedNow, subscribeUiClock, uiClockStatsForProofs } from '../../src/utils/cockpit/uiClock.js'

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
  check('§1 same cadence shares ONE bucket', stats[100] === 2, JSON.stringify(stats))
  check('§1 distinct cadences get distinct buckets', stats[50] === 1, JSON.stringify(stats))
}

await sleep(370)
check('§2 both subscribers ticked ~3× in 370ms @100ms', aTicks >= 2 && aTicks <= 5 && bTicks >= 2 && bTicks <= 5, `a=${aTicks} b=${bTicks}`)
check('§2 subscribers of one bucket tick in lockstep', aTicks === bTicks, `a=${aTicks} b=${bTicks}`)

check('§3 quantizedNow is cadence-aligned', quantizedNow(100) % 100 === 0)

{
  const before = aTicks
  markScrollActivity()
  await sleep(120)
  check('§4 ticks are skipped during scroll drain', aTicks === before, `+${aTicks - before}`)
  await sleep(250)
  check('§4 ticks resume after drain clears', aTicks > before, `+${aTicks - before}`)
}

unsubA()
{
  const stats = uiClockStatsForProofs()
  check('§5 partial unsubscribe keeps the bucket', stats[100] === 1, JSON.stringify(stats))
}
unsubB()
unsubC()
{
  const stats = uiClockStatsForProofs()
  check('§5 zero buckets after last unsubscribe', Object.keys(stats).length === 0, JSON.stringify(stats))
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
    check('§6 discriminator: raw quantizedNow DOES move across the boundary (the refuted one-liner would too)', qa !== qb, `${qa} vs ${qb}`)
    check('§6 lastClockTick is Object.is-stable across a mid-render boundary crossing (no notification, no move)', a === b, `${a} vs ${b}`)
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
  check('§6b the stamp advances WITH notifications', ticks >= 1 && lastClockTick(100) > start, `ticks=${ticks}`)
  markScrollActivity()
  const frozen = lastClockTick(100)
  await sleep(120)
  check('§6b the stamp never moves during scroll drain (no notify ⇒ no move)', lastClockTick(100) === frozen, `${frozen} vs ${lastClockTick(100)}`)
  await sleep(250)
  check('§6b …and resumes with the ticks after the drain clears', lastClockTick(100) > frozen)
  unsub()
}

{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hooks', 'useElapsedTime.ts'), 'utf8')
  check('§6c useElapsedTime derives the running snapshot from lastClockTick(ms)', src.includes('lastClockTick(ms)'))
  check('§6c the old raw-Date.now snapshot derivation is gone', !src.includes('endTime ?? Date.now()'))
}

console.log(failures === 0 ? '\n✓ prove-ui-clock: all green' : `\n✗ prove-ui-clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
