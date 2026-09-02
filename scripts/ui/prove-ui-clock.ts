#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-ui-clock.ts — the shared cadence scheduler oracle
// one timer per cadence bucket, quantized ticks,
//  scroll-drain suppression, zero live timers after last unsubscribe.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-ui-clock.ts
// ============================================================================
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

// §1 — bucket sharing: N subscribers of one cadence, ONE timer
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

// §2 — ticks arrive at the cadence for every subscriber
await sleep(370)
check('§2 both subscribers ticked ~3× in 370ms @100ms', aTicks >= 2 && aTicks <= 5 && bTicks >= 2 && bTicks <= 5, `a=${aTicks} b=${bTicks}`)
check('§2 subscribers of one bucket tick in lockstep', aTicks === bTicks, `a=${aTicks} b=${bTicks}`)

// §3 — quantization: the tick value is cadence-aligned (output-edge dedupe)
check('§3 quantizedNow is cadence-aligned', quantizedNow(100) % 100 === 0)

// §4 — scroll-drain suppression: ticks skip while draining
{
  const before = aTicks
  markScrollActivity() // arms a 150ms drain window
  await sleep(120) // inside the window — the ~1 tick here must be skipped
  check('§4 ticks are skipped during scroll drain', aTicks === before, `+${aTicks - before}`)
  await sleep(250) // window cleared — ticks resume
  check('§4 ticks resume after drain clears', aTicks > before, `+${aTicks - before}`)
}

// §5 — teardown: last unsubscribe removes the bucket + timer
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

// §6 — the STORED tick (store-foundation fix 5): lastClockTick is a pure
// store read that moves only WITH a notification. The refuted one-liner
// (deriving getSnapshot from quantizedNow) re-reads Date.now, so a
// quantization boundary crossed mid-render still produced two different
// snapshots between notifications — the stored stamp cannot.
{
  const unsub = subscribeUiClock(1000, () => {})
  const realNow = Date.now
  try {
    const aligned = Math.floor(realNow() / 1000) * 1000
    Date.now = () => aligned + 995
    const qa = quantizedNow(1000)
    const a = lastClockTick(1000)
    Date.now = () => aligned + 1005 // the wall clock crosses the bucket boundary mid-render
    const qb = quantizedNow(1000)
    const b = lastClockTick(1000)
    check('§6 discriminator: raw quantizedNow DOES move across the boundary (the refuted one-liner would too)', qa !== qb, `${qa} vs ${qb}`)
    check('§6 lastClockTick is Object.is-stable across a mid-render boundary crossing (no notification, no move)', a === b, `${a} vs ${b}`)
  } finally {
    Date.now = realNow
  }
  unsub()
}

// §6b — the stamp moves ONLY with a notification: it advances on a real
// tick, and never during scroll drain (where ticks are skipped).
{
  let ticks = 0
  const unsub = subscribeUiClock(100, () => ticks++)
  const start = lastClockTick(100)
  await sleep(250)
  check('§6b the stamp advances WITH notifications', ticks >= 1 && lastClockTick(100) > start, `ticks=${ticks}`)
  markScrollActivity() // arms a 150ms drain window — ticks are skipped
  const frozen = lastClockTick(100)
  await sleep(120)
  check('§6b the stamp never moves during scroll drain (no notify ⇒ no move)', lastClockTick(100) === frozen, `${frozen} vs ${lastClockTick(100)}`)
  await sleep(250)
  check('§6b …and resumes with the ticks after the drain clears', lastClockTick(100) > frozen)
  unsub()
}

// §6c — the consumer wiring: useElapsedTime's running snapshot derives from
// the stored tick, and no arm of its snapshot reads raw Date.now on the
// subscribed path (the not-running arm freezes; endTime freezes).
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hooks', 'useElapsedTime.ts'), 'utf8')
  check('§6c useElapsedTime derives the running snapshot from lastClockTick(ms)', src.includes('lastClockTick(ms)'))
  check('§6c the old raw-Date.now snapshot derivation is gone', !src.includes('endTime ?? Date.now()'))
}

console.log(failures === 0 ? '\n✓ prove-ui-clock: all green' : `\n✗ prove-ui-clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
