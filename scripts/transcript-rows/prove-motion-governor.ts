#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __motionGovernorResetForTest,
  __setLoopMeterForTest,
  __setMotionRestTimersForTest,
  MOTION_QUIET_AFTER_MS,
  motionRestState,
  noteMotionInput,
  restMotionPaused,
  settledMotionLevel,
  clockPeriodMs,
  FRAME_BUDGET_MS,
  governorLevel,
  idleMotionLevel,
  idleMotionWord,
  LOOP_BUSY_SHARE,
  noteFrameCost,
  REDUCED_CEILING_MS,
  REDUCED_FLOOR_MS,
  reducedPeriodMs,
  RELEASE_RUN,
  setMotionPosture,
  subscribeIdleMotion,
  TRIP_RUN,
  TRIP_RUN_COST_MS,
} from '../../src/utils/cockpit/motionGovernor.js'
import { FRAME_INTERVAL_MS } from '../../src/ink/constants.js'
import { createClock, providerClockPeriodMs, type ClockTimers } from '../../src/ink/components/ClockContext.js'
import { critterIdleTickMs, IDLE_TICK_MS, SLEEP_TICK_MS } from '../../src/utils/cockpit/critterIdle.js'
import {
  DECOR_TICK_MS,
  glyphTickMs,
  READY_TICK_MS,
  REDUCED_TICK_MS,
  WORK_TICK_MS,
} from '../../src/utils/cockpit/liveGlyphs.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

function meter(share: number | null): void {
  __setLoopMeterForTest({ begin() {}, busyShare: () => share })
}
function reset(): void {
  __motionGovernorResetForTest()
  delete process.env.MERCURY_CRITTER_IDLE
  delete process.env.MERCURY_LIVE_GLYPHS
  meter(1)
}
const feed = (costMs: number, n: number): void => {
  for (let i = 0; i < n; i++) noteFrameCost(costMs)
}
const OVER = Math.ceil(TRIP_RUN_COST_MS / TRIP_RUN) + 10
const UNDER = FRAME_BUDGET_MS - 8
const MILD = FRAME_BUDGET_MS + 4

console.log('============================================================')
console.log(' motion governor — the fixture seam, the clock, the tickers')
console.log('============================================================')

section('G1 the shape')
check('the trip run is shorter than the release run (hysteresis)', TRIP_RUN < RELEASE_RUN, `${TRIP_RUN} < ${RELEASE_RUN}`)
check('the frame budget IS the paint cadence', FRAME_BUDGET_MS === FRAME_INTERVAL_MS, `${FRAME_BUDGET_MS}`)
check('the reduced floor IS the glyph schedule\'s slow tick (one number)', REDUCED_FLOOR_MS === REDUCED_TICK_MS && REDUCED_FLOOR_MS === 250, `${REDUCED_FLOOR_MS}`)
check('the ceiling sits above the floor', REDUCED_CEILING_MS > REDUCED_FLOOR_MS, `${REDUCED_CEILING_MS}`)
check('the confirmation asks for a loop at least half busy', LOOP_BUSY_SHARE === 0.5, `${LOOP_BUSY_SHARE}`)
check('the run\'s paint-time gate is a slow machine\'s twelve frames, not a fast one\'s burst', TRIP_RUN_COST_MS === 600 && TRIP_RUN * MILD < TRIP_RUN_COST_MS && TRIP_RUN * OVER >= TRIP_RUN_COST_MS, `${TRIP_RUN_COST_MS}`)

section('G2 the trip')
reset()
let notices = 0
const unsub = subscribeIdleMotion(() => notices++)
check('boot: full, no word', governorLevel() === 'full' && idleMotionWord() === null)
feed(OVER, TRIP_RUN - 1)
check(`${TRIP_RUN - 1} over-budget frames: still full`, governorLevel() === 'full')
noteFrameCost(OVER)
check(`the ${TRIP_RUN}th over-budget frame trips REDUCED`, governorLevel() === 'reduced')
check('the level is reduced for every part under auto', idleMotionLevel('critter') === 'reduced' && idleMotionLevel('glyphs') === 'reduced' && idleMotionLevel('clock') === 'reduced')
check('the word is present while reduced', idleMotionWord() === 'reduced')
check('exactly one notice for the trip', notices === 1, `${notices}`)
check('the reduced cadence starts at the floor', reducedPeriodMs() === REDUCED_FLOOR_MS)
unsub()
reset()
feed(MILD, TRIP_RUN * 2)
check(`${TRIP_RUN * 2} mildly heavy frames (a fast machine's burst) never trip: the run's paint time is under the gate`, governorLevel() === 'full')
const mildRun = Math.ceil(TRIP_RUN_COST_MS / MILD)
reset()
feed(MILD, mildRun - 1)
check(`…until the run's paint time reaches the gate (${mildRun - 1} frames: still full)`, governorLevel() === 'full')
noteFrameCost(MILD)
check(`…the ${mildRun}th mildly heavy frame trips (the run is measured in paint time too)`, governorLevel() === 'reduced')

section('G3 the confirmation')
reset()
meter(LOOP_BUSY_SHARE - 0.1)
feed(OVER, TRIP_RUN * 3)
check('a mostly idle loop denies the trip through three trip runs', governorLevel() === 'full')
meter(LOOP_BUSY_SHARE)
feed(OVER, TRIP_RUN)
check('the loop at the busy share confirms the next run', governorLevel() === 'reduced')
reset()
meter(null)
feed(OVER, TRIP_RUN)
check('no loop meter (the runtime lacks one): the trigger stands alone', governorLevel() === 'reduced')

section('G4 the release')
reset()
feed(OVER, TRIP_RUN)
check('reduced', governorLevel() === 'reduced')
noteFrameCost(REDUCED_FLOOR_MS + 10)
check('the cadence rose off the floor', reducedPeriodMs() > REDUCED_FLOOR_MS, `${reducedPeriodMs()}`)
feed(UNDER, RELEASE_RUN - 1)
check(`${RELEASE_RUN - 1} cheap frames: still reduced`, governorLevel() === 'reduced')
noteFrameCost(UNDER)
check(`the ${RELEASE_RUN}th cheap frame releases to FULL`, governorLevel() === 'full')
check('the word is gone after the release', idleMotionWord() === null)
check('the cadence is back at the floor for the next trip', reducedPeriodMs() === REDUCED_FLOOR_MS)

section('G5 no flap')
reset()
for (let i = 0; i < 200; i++) noteFrameCost(i % 2 === 0 ? FRAME_BUDGET_MS - 1 : FRAME_BUDGET_MS + 1)
check('a cost hovering at the budget never trips (200 frames)', governorLevel() === 'full')
reset()
feed(OVER, TRIP_RUN)
for (let i = 0; i < 200; i++) noteFrameCost(i % 2 === 0 ? FRAME_BUDGET_MS - 1 : FRAME_BUDGET_MS + 1)
check('a cost hovering at the budget never releases (200 frames)', governorLevel() === 'reduced')
reset()
feed(OVER, TRIP_RUN - 1)
noteFrameCost(UNDER)
feed(OVER, TRIP_RUN - 1)
check('one cheap frame inside a trip run restarts the count', governorLevel() === 'full')
noteFrameCost(OVER)
check('…and a full run after it trips', governorLevel() === 'reduced')

section('G6 the cadence follows the cost')
reset()
feed(OVER, TRIP_RUN)
const steps: number[] = []
for (const cost of [REDUCED_FLOOR_MS + 50, 2 * REDUCED_FLOOR_MS + 100, 4 * REDUCED_FLOOR_MS + 200, 10 * REDUCED_CEILING_MS]) {
  noteFrameCost(cost)
  steps.push(reducedPeriodMs())
}
check('a frame over the interval doubles the period: 500 → 1000 → 2000, capped at the ceiling', steps.join(',') === '500,1000,2000,2000', steps.join(','))
const back: number[] = []
for (let i = 0; i < 4; i++) {
  noteFrameCost(REDUCED_FLOOR_MS / 4)
  back.push(reducedPeriodMs())
}
check('cheap frames halve it back to the floor and hold there: 1000 → 500 → 250 → 250', back.join(',') === '1000,500,250,250', back.join(','))
noteFrameCost(REDUCED_FLOOR_MS + 10)
const lifted = reducedPeriodMs()
noteFrameCost(REDUCED_FLOOR_MS - 10)
noteFrameCost(REDUCED_FLOOR_MS + 10)
noteFrameCost(REDUCED_FLOOR_MS - 10)
check('a cost hovering at the interval holds the lifted period (no see-saw)', lifted === 2 * REDUCED_FLOOR_MS && reducedPeriodMs() === lifted, `${lifted} → ${reducedPeriodMs()}`)
check('the clock period follows the lifted cadence', clockPeriodMs(FRAME_INTERVAL_MS) === lifted)

section('G7 the posture')
reset()
feed(OVER, TRIP_RUN)
setMotionPosture('full')
check('full never reduces: the governor says reduced, the level is full, no word', governorLevel() === 'reduced' && idleMotionLevel('clock') === 'full' && idleMotionWord() === null)
reset()
setMotionPosture('reduced')
check('reduced stands with the governor at full: the level is reduced, the word shows', governorLevel() === 'full' && idleMotionLevel('critter') === 'reduced' && idleMotionWord() === 'reduced')
setMotionPosture('off')
check('off stops every part, no word', idleMotionLevel('critter') === 'off' && idleMotionLevel('glyphs') === 'off' && idleMotionLevel('clock') === 'off' && idleMotionWord() === null)
setMotionPosture('auto')
check('auto reads the governor (full now)', idleMotionLevel('clock') === 'full')
feed(OVER, TRIP_RUN)
check('auto reads the governor (reduced after a trip)', idleMotionLevel('clock') === 'reduced')

section('G8 the env switches')
reset()
process.env.MERCURY_CRITTER_IDLE = '0'
check('MERCURY_CRITTER_IDLE=0: the critter part off, the glyph part and the clock untouched', idleMotionLevel('critter') === 'off' && idleMotionLevel('glyphs') === 'full' && idleMotionLevel('clock') === 'full')
delete process.env.MERCURY_CRITTER_IDLE
process.env.MERCURY_LIVE_GLYPHS = '0'
check('MERCURY_LIVE_GLYPHS=0: the glyph part off, the critter part and the clock untouched', idleMotionLevel('glyphs') === 'off' && idleMotionLevel('critter') === 'full' && idleMotionLevel('clock') === 'full')
process.env.MERCURY_CRITTER_IDLE = '0'
feed(OVER, TRIP_RUN)
check('both =0: the whole choice off — even with the governor reduced, no part runs and no word shows', governorLevel() === 'reduced' && idleMotionLevel('clock') === 'off' && idleMotionWord() === null)
setMotionPosture('reduced')
check('both =0 outrank a saved reduced too', idleMotionLevel('critter') === 'off' && idleMotionLevel('glyphs') === 'off')
reset()

section('G9 the clock')
reset()
check('focused: the frame interval', providerClockPeriodMs(true) === FRAME_INTERVAL_MS)
check('blurred: half rate', providerClockPeriodMs(false) === FRAME_INTERVAL_MS * 2)
feed(OVER, TRIP_RUN)
check('reduced: the floor over either', providerClockPeriodMs(true) === REDUCED_FLOOR_MS && providerClockPeriodMs(false) === REDUCED_FLOOR_MS)
noteFrameCost(REDUCED_FLOOR_MS + 10)
check('reduced with a lifted cadence: the lifted period', providerClockPeriodMs(true) === 2 * REDUCED_FLOOR_MS)
reset()

function fixtureTimers(): ClockTimers & { advance(ms: number): void } {
  let t = 0
  type Interval = { fn: () => void; ms: number; next: number; live: boolean }
  const intervals: Interval[] = []
  return {
    now: () => t,
    setInterval: (fn, ms) => {
      const iv: Interval = { fn, ms, next: t + ms, live: true }
      intervals.push(iv)
      return iv
    },
    clearInterval: timer => {
      ;(timer as Interval).live = false
    },
    advance(ms) {
      const end = t + ms
      for (;;) {
        const due = intervals.filter(iv => iv.live && iv.next <= end).sort((a, b) => a.next - b.next)[0]
        if (!due) break
        t = due.next
        due.next += due.ms
        due.fn()
      }
      t = end
    },
  }
}
{
  const timers = fixtureTimers()
  const clock = createClock(FRAME_INTERVAL_MS, timers)
  let ticks = 0
  const off = clock.subscribe(() => ticks++, true)
  timers.advance(1000)
  check('a keep-alive subscriber at the frame interval: 62 ticks in a fixture second', ticks === 62, `${ticks}`)
  clock.setInterval(REDUCED_FLOOR_MS)
  ticks = 0
  timers.advance(1000)
  check('the same clock at the floor: 4 ticks in a fixture second', ticks === 4, `${ticks}`)
  off()
  ticks = 0
  timers.advance(1000)
  check('no keep-alive subscriber: the clock does not tick at all (on demand only)', ticks === 0, `${ticks}`)
}

section('G10 the tickers follow')
check('the critter ticks at its own cadence at full (awake · asleep)', critterIdleTickMs('full', false) === IDLE_TICK_MS && critterIdleTickMs('full', true) === SLEEP_TICK_MS)
check('the critter PAUSES at reduced and at off (no tick)', critterIdleTickMs('reduced', false) === null && critterIdleTickMs('reduced', true) === null && critterIdleTickMs('off', false) === null)
check('a glyph samples at its own tick at full', glyphTickMs('full', WORK_TICK_MS) === WORK_TICK_MS && glyphTickMs('full', READY_TICK_MS) === READY_TICK_MS)
check('a glyph samples at the slow tick at reduced', glyphTickMs('reduced', WORK_TICK_MS) === REDUCED_TICK_MS && glyphTickMs('reduced', READY_TICK_MS) === REDUCED_TICK_MS)
check('a glyph already slower than the floor keeps its own tick at reduced', glyphTickMs('reduced', DECOR_TICK_MS) === DECOR_TICK_MS)
check('a glyph does not sample at off', glyphTickMs('off', WORK_TICK_MS) === null)
{
  const commits = (clockMs: number, sampleMs: number): number => {
    const timers = fixtureTimers()
    const clock = createClock(clockMs, timers)
    let last = Math.floor(clock.now() / sampleMs)
    let n = 0
    const off = clock.subscribe(() => {
      const bucket = Math.floor(clock.now() / sampleMs)
      if (bucket !== last) {
        last = bucket
        n++
      }
    }, true)
    timers.advance(1000)
    off()
    return n
  }
  const full = commits(FRAME_INTERVAL_MS, glyphTickMs('full', WORK_TICK_MS)!)
  const reduced = commits(REDUCED_FLOOR_MS, glyphTickMs('reduced', WORK_TICK_MS)!)
  check(`a working glyph commits ${full}× a second at full and ${reduced}× at reduced (6 → 4)`, full === 6 && reduced === 4, `${full} → ${reduced}`)
  const critterFull = commits(FRAME_INTERVAL_MS, IDLE_TICK_MS)
  check(`the critter's sampler runs ${critterFull}× a second at full and not at all below it`, critterFull === 12 && critterIdleTickMs('reduced', false) === null, `${critterFull}`)
}

section('G11 the seams')
{
  const ink = src('src/ink/ink.tsx')
  check('the paint tail feeds the governor the frame\'s measured cost', /noteFrameCost\(durationMs\)/.test(ink))
  check('the paint tail burns the cost pad before the cost is measured', ink.indexOf('burnFrameCostPad()') < ink.indexOf('noteFrameCost(durationMs)') && ink.indexOf('burnFrameCostPad()') > 0)
  const clockSrc = src('src/ink/components/ClockContext.tsx')
  check('the clock provider reads its period through the governor', /clockPeriodMs\(/.test(clockSrc) && /subscribeIdleMotion/.test(clockSrc))
  const frame = src('src/components/MercuryFrame.tsx')
  check('the frame paints the one word from the clock\'s level', /useSettledMotion\('clock'\)/.test(frame) && />reduced<\/Text>/.test(frame))
  const glyphs = src('src/components/mercury-ui/LiveGlyphs.tsx')
  check('the glyph primitives read their tick through the level (no separate gate)', /glyphTickMs\(useIdleMotion\('glyphs'\)/.test(glyphs) && !/liveGlyphsEnabled\(/.test(glyphs))
  const critter = src('src/components/mercury-ui/AnimatedCritterArt.tsx')
  check('the critter reads its tick through the level', /critterIdleTickMs\(motionLevel, asleep\)/.test(critter) && !/critterIdleEnabled\(/.test(critter))
  const governor = src('src/utils/cockpit/motionGovernor.ts')
  check('the governor is config-free (flag reads only — the ink layer taps it)', !/utils\/config/.test(governor) && /flagRegistry/.test(governor))
  const registry = src('src/substrate/flagRegistry.ts')
  check('the registry rows name the Motion choice for both switches', /MERCURY_CRITTER_IDLE'.*the critter part of the Motion choice/.test(registry) && /MERCURY_LIVE_GLYPHS'.*the glyph part of the Motion choice/.test(registry))
  check('the cost pad has its registry row', /env: 'MERCURY_FRAME_COST_PAD_MS'/.test(registry))
}
reset()

console.log(`\n${failures === 0 ? '✅ motion governor GREEN' : `❌ motion governor RED — ${failures} failure(s)`}`)

section('quiet and focus behavior with deterministic input and turn signals')
{
  const { setTerminalFocused, resetTerminalFocusState } = await import('../../src/ink/session/focus-store.ts')
  const { publishCompanionTurnAt, resetCompanionSignals } = await import('../../src/utils/cockpit/companionSignals.ts')
  const { motionValueWords, motionDetailLines } = await import('../../src/utils/cockpit/motionSetting.ts')
  let now = 0
  const timers: Array<{ fn: () => void; at: number; active: boolean }> = []
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const timer = timers.filter(value => value.active && value.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      now = timer.at
      timer.active = false
      timer.fn()
    }
    now = end
  }
  resetTerminalFocusState()
  resetCompanionSignals()
  reset()
  __setMotionRestTimersForTest({
    setTimeout(fn, ms) { const timer = { fn, at: now + ms, active: true }; timers.push(timer); return timer },
    clearTimeout(timer) { (timer as { active: boolean }).active = false },
  })
  const stop = subscribeIdleMotion(() => {})
  const words = motionValueWords('auto')
  const details = JSON.stringify(motionDetailLines())
  advance(MOTION_QUIET_AFTER_MS - 1)
  check('auto remains awake before the quiet deadline', motionRestState() === 'awake' && idleMotionLevel('clock') === 'full')
  advance(1)
  check('quiet auto uses the reduced cadence and rests ambient decoration', motionRestState() === 'quiet' && idleMotionLevel('clock') === 'reduced' && restMotionPaused() && clockPeriodMs(16) === REDUCED_FLOOR_MS)
  check('quiet is not reported as a load reduction', settledMotionLevel('clock') === 'full' && idleMotionWord() === null && motionValueWords('auto') === words && JSON.stringify(motionDetailLines()) === details)
  noteMotionInput()
  check('input wakes motion immediately and starts a fresh quiet period', motionRestState() === 'awake' && idleMotionLevel('clock') === 'full' && !restMotionPaused())
  advance(MOTION_QUIET_AFTER_MS)
  check('motion rests again after the new quiet period', motionRestState() === 'quiet')
  for (const field of ['turnLive', 'streaming', 'awaitingPermission'] as const) {
    publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false, [field]: true }, now)
    advance(MOTION_QUIET_AFTER_MS * 2)
    check(`${field}: active work prevents quiet motion`, motionRestState() === 'awake' && idleMotionLevel('clock') === 'full')
    setTerminalFocused(false)
    check(`${field}: live work keeps its animation clock while blurred`, motionRestState() === 'awake' && clockPeriodMs(32) === 32)
    publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now)
    check(`${field}: settling while blurred stops idle motion`, motionRestState() === 'blurred' && idleMotionLevel('clock') === 'off' && clockPeriodMs(32) === 0)
    setTerminalFocused(true)
    check(`${field}: focus restores motion immediately`, motionRestState() === 'awake' && idleMotionLevel('clock') === 'full')
  }
  for (const posture of ['auto', 'reduced', 'full', 'off'] as const) {
    setMotionPosture(posture)
    noteMotionInput()
    advance(MOTION_QUIET_AFTER_MS)
    const quietLevel = posture === 'full' ? 'full' : posture === 'off' ? 'off' : 'reduced'
    check(`${posture}: the quiet policy preserves the selected setting`, idleMotionLevel('clock') === quietLevel && restMotionPaused() === (posture !== 'full'))
    setTerminalFocused(false)
    const blurred = posture === 'full' ? 'full' : 'off'
    check(`${posture}: the focus policy preserves full and off`, idleMotionLevel('clock') === blurred && clockPeriodMs(32) === (posture === 'auto' || posture === 'reduced' ? 0 : 32))
    setTerminalFocused(true)
  }
  const fixture = fixtureTimers()
  const clock = createClock(16, fixture)
  let ticks = 0
  const unclock = clock.subscribe(() => ticks++, true)
  fixture.advance(1000)
  check('the fixture animation clock is initially running', ticks > 0)
  clock.setInterval(0)
  ticks = 0
  fixture.advance(1000)
  check('a stopped animation clock produces no ticks despite keep-alive subscribers', ticks === 0)
  clock.setInterval(16)
  fixture.advance(1000)
  check('the same clock resumes on focus or live work', ticks > 0)
  unclock()
  stop()
  check('unmount releases the quiet timer', timers.every(timer => !timer.active))
  __setMotionRestTimersForTest(null)
  resetTerminalFocusState()
  resetCompanionSignals()
  reset()
  const app = src('src/ink/components/App.tsx')
  check('the input handler excludes focus reports from ordinary activity', app.includes('atom.sequence !== FOCUS_IN && atom.sequence !== FOCUS_OUT') && app.includes('noteMotionInput()'))
  const glyphs = src('src/components/mercury-ui/LiveGlyphs.tsx')
  check('both ambient glyph components read the shared rest state', glyphs.includes('useRestMotionPause') && (glyphs.match(/!typing && !resting && tick !== null/g) ?? []).length === 2)
}

console.log(failures === 0 ? 'rest motion: green' : `rest motion: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
