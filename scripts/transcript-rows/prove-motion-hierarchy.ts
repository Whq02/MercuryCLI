#!/usr/bin/env bun
import {
  DECOR_TICK_MS,
  FOCAL_TICK_MS,
  READY_BUCKETS,
  READY_TICK_MS,
  readyBucket,
  TWINKLE_CYCLE,
  TWINKLE_MS,
  TWINKLE_TICK_MS,
  twinkleBright,
  WORK_FRAMES,
  WORK_TICK_MS,
  workGlyphForTime,
} from '../../src/screen/cockpit/liveGlyphs.js'
import {
  __typingActivityResetForTest,
  isTypingActive,
  markTypingActivity,
  subscribeTypingActivity,
  TYPING_HOLD_MS,
} from '../../src/screen/cockpit/typingActivity.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('the nested clock family — 80 ⊂ 160 ⊂ 320')
check(
  'FOCAL divides the truth lattice (every 160 edge IS an 80 edge)',
  WORK_TICK_MS % FOCAL_TICK_MS === 0,
  `${WORK_TICK_MS} % ${FOCAL_TICK_MS}`,
  'make WORK_TICK_MS a multiple of FOCAL_TICK_MS in src/screen/cockpit/liveGlyphs.ts',
)
check(
  'DECOR is a multiple of the truth lattice (every 320 edge IS a 160 edge)',
  DECOR_TICK_MS % WORK_TICK_MS === 0,
  `${DECOR_TICK_MS} % ${WORK_TICK_MS}`,
  'make DECOR_TICK_MS a multiple of WORK_TICK_MS in src/screen/cockpit/liveGlyphs.ts',
)
check('TWINKLE rides the DECOR tick', TWINKLE_TICK_MS === DECOR_TICK_MS, '', 'set TWINKLE_TICK_MS to DECOR_TICK_MS in src/screen/cockpit/liveGlyphs.ts')
check(
  'READY sampling is lattice-nested (160 or a nested multiple)',
  READY_TICK_MS % WORK_TICK_MS === 0 || WORK_TICK_MS % READY_TICK_MS === 0,
  '',
  'READY_TICK_MS in src/screen/cockpit/liveGlyphs.ts must divide or be a multiple of WORK_TICK_MS',
)
check(
  'focal sampling of the WORK rotation stays frame-0 static at t=0',
  workGlyphForTime(0) === WORK_FRAMES[0],
  '',
  'workGlyphForTime in src/screen/cockpit/liveGlyphs.ts must return WORK_FRAMES[0] at time 0',
)

section('the GLOW greeting joins the lattice')
{
  const shim = await import('../../src/screen/cockpit/greetingShimmer.js')
  check(
    'the greeting samples on the FOCAL lane (nested by construction)',
    shim.SHIMMER_TICK_MS === FOCAL_TICK_MS,
    `${shim.SHIMMER_TICK_MS}`,
    'set SHIMMER_TICK_MS to FOCAL_TICK_MS in src/screen/cockpit/greetingShimmer.ts',
  )
  check(
    'the greeting is TRANSIENT: the phase law reaches its terminal token at the window',
    shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, 27) === shim.SHIMMER_SETTLED &&
      shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS * 10, 27) === shim.SHIMMER_SETTLED,
    '',
    'shimmerPhaseKey in src/screen/cockpit/greetingShimmer.ts must return SHIMMER_SETTLED once elapsed time reaches SHIMMER_GREETING_MS',
  )
  check(
    'frame 0 is the settled cell (gain 0 parses to a null phase)',
    shim.shimmerPhaseOf(shim.shimmerPhaseKey(0, 27), 27) === null,
    '',
    'shimmerPhaseKey and shimmerPhaseOf in src/screen/cockpit/greetingShimmer.ts must give a null phase at elapsed 0',
  )
}

section('decor sampling loses nothing visible')
check(
  'the glint outlives one DECOR sample (a 320ms sampler can never skip it)',
  TWINKLE_MS > DECOR_TICK_MS,
  `${TWINKLE_MS} > ${DECOR_TICK_MS}`,
  'make TWINKLE_MS longer than DECOR_TICK_MS in src/screen/cockpit/liveGlyphs.ts',
)
{
  let allPhasesSee = true
  for (let phase = 0; phase < DECOR_TICK_MS; phase += 7) {
    let saw = false
    for (let t = phase; t < TWINKLE_CYCLE + phase; t += TWINKLE_TICK_MS) {
      if (twinkleBright(t)) saw = true
    }
    if (!saw) allPhasesSee = false
  }
  check('every sampler phase sees the glint at least once per cycle', allPhasesSee, '', 'twinkleBright and TWINKLE_CYCLE in src/screen/cockpit/liveGlyphs.ts must light the glint at least once per cycle for every sampler phase')
}
{
  let minRun = Infinity
  let runStart = 0
  let prev = readyBucket(0)
  for (let t = 1; t <= 3400 * 2; t++) {
    const b = readyBucket(t)
    if (b !== prev) {
      minRun = Math.min(minRun, t - runStart)
      runStart = t
      prev = b
    }
  }
  check(
    `READY bucket dwell ≥ its own tick (no rendered step skipped)`,
    minRun >= READY_TICK_MS,
    `min dwell ${minRun}ms ≥ ${READY_TICK_MS}`,
    'readyBucket in src/screen/cockpit/liveGlyphs.ts must hold each bucket for at least READY_TICK_MS',
  )
  check(`READY buckets sane`, READY_BUCKETS >= 3, '', 'READY_BUCKETS in src/screen/cockpit/liveGlyphs.ts must be at least 3')
}

section('typingActivity — the decor pause store')
{
  __typingActivityResetForTest()
  check('initially not typing', isTypingActive() === false, '', 'isTypingActive in src/screen/cockpit/typingActivity.ts must be false after __typingActivityResetForTest')
  let notifications = 0
  const unsub = subscribeTypingActivity(() => notifications++)
  markTypingActivity()
  check('keystroke ⇒ typing active', isTypingActive() === true, '', 'markTypingActivity in src/screen/cockpit/typingActivity.ts must make isTypingActive true')
  check('subscribers notified on the false→true edge', notifications === 1, '', 'markTypingActivity in src/screen/cockpit/typingActivity.ts must notify subscribers on the false-to-true edge')
  markTypingActivity()
  check('repeat keystrokes do not re-notify (edge-triggered)', notifications === 1, '', 'markTypingActivity in src/screen/cockpit/typingActivity.ts must not notify again while typing is already active')
  const flipped = await new Promise<boolean>(resolve => {
    const deadline = setTimeout(() => resolve(false), TYPING_HOLD_MS + 1000)
    const un2 = subscribeTypingActivity(() => {
      if (!isTypingActive()) {
        clearTimeout(deadline)
        un2()
        resolve(true)
      }
    })
  })
  check(`typing releases ~${TYPING_HOLD_MS}ms after the last keystroke`, flipped, '', 'the hold timer in src/screen/cockpit/typingActivity.ts must clear typing and notify subscribers after TYPING_HOLD_MS')
  check('post-release snapshot is false', isTypingActive() === false, '', 'isTypingActive in src/screen/cockpit/typingActivity.ts must be false after the hold ends')
  check('release notified subscribers', notifications === 2, '', 'the hold timer in src/screen/cockpit/typingActivity.ts must notify subscribers once when typing releases')
  unsub()
  __typingActivityResetForTest()
}


console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-motion-hierarchy: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ motion-hierarchy — tiers, lattice, typing pause: all pinned')
