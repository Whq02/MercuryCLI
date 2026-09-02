#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-motion-hierarchy.ts — COCKPIT S2: the
//  three-tier motion hierarchy (FOCAL 80 · TRUTH 160 · DECOR 320 + typing
//  pause), proven React-free where the schedule lives plus source pins at
//  the adoption seams.
//
//  The doctrine (liveGlyphs.ts header): exactly ONE focal element (the
//  live-edge spinner) samples at 80ms; state-carrying truth stays on the
//  160 lattice and never pauses; decoration samples at 320 and pauses
//  entirely while the operator types. Nested clocks (80 ⊂ 160 ⊂ 320) mean
//  every coarser edge coincides with a finer one — coincident advances
//  batch into one compose.
//
//  Measured: requesting-mode writes/s
//  15.42 (50ms, off-lattice) → 9.56 (80ms focal) → 7.25 (160 variant —
//  rejected: the one deliberately fluid pre-first-token sweep chunks at
//  6.25 samples/s). All three under the ≤30 composed-flushes/s gate; 80
//  chosen per the lattice-alignment ruling.
//
//  Run: ~/.bun/bin/bun run scripts/transcript-rows/prove-motion-hierarchy.ts
// ============================================================================
import { readFileSync } from 'node:fs'
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
} from '../../src/utils/cockpit/liveGlyphs.js'
import {
  __typingActivityResetForTest,
  isTypingActive,
  markTypingActivity,
  subscribeTypingActivity,
  TYPING_HOLD_MS,
} from '../../src/utils/cockpit/typingActivity.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('the nested clock family — 80 ⊂ 160 ⊂ 320')
check(
  'FOCAL divides the truth lattice (every 160 edge IS an 80 edge)',
  WORK_TICK_MS % FOCAL_TICK_MS === 0,
  `${WORK_TICK_MS} % ${FOCAL_TICK_MS}`,
)
check(
  'DECOR is a multiple of the truth lattice (every 320 edge IS a 160 edge)',
  DECOR_TICK_MS % WORK_TICK_MS === 0,
  `${DECOR_TICK_MS} % ${WORK_TICK_MS}`,
)
check('TWINKLE rides the DECOR tick', TWINKLE_TICK_MS === DECOR_TICK_MS)
check(
  'READY sampling is lattice-nested (160 or a nested multiple)',
  READY_TICK_MS % WORK_TICK_MS === 0 || WORK_TICK_MS % READY_TICK_MS === 0,
)
check(
  'focal sampling of the WORK rotation stays frame-0 static at t=0',
  workGlyphForTime(0) === WORK_FRAMES[0],
)

section('the GLOW greeting joins the lattice')
{
  const shim = await import('../../src/utils/cockpit/greetingShimmer.js')
  check(
    'the greeting samples on the FOCAL lane (nested by construction)',
    shim.SHIMMER_TICK_MS === FOCAL_TICK_MS,
    `${shim.SHIMMER_TICK_MS}`,
  )
  check(
    'the greeting is TRANSIENT: the phase law reaches its terminal token at the window',
    shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, 27) === shim.SHIMMER_SETTLED &&
      shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS * 10, 27) === shim.SHIMMER_SETTLED,
  )
  check(
    'frame 0 is the settled cell (gain 0 parses to a null phase)',
    shim.shimmerPhaseOf(shim.shimmerPhaseKey(0, 27), 27) === null,
  )
  const hook = readFileSync('src/components/mercury-ui/useGreetingShimmer.ts', 'utf8')
  check(
    'the React owner drops its clock at settle (intervalMs null once settled — the subscriber-counted law)',
    hook.includes('animate ? SHIMMER_TICK_MS : null') && hook.includes('SHIMMER_SETTLED') && hook.includes('setSettled(true)'),
  )
  check(
    'the React owner honors the reduced-motion pair + the live-glyphs capture gate',
    hook.includes('prefersReducedMotion') && hook.includes('MERCURY_REDUCED_MOTION') && hook.includes('liveGlyphsEnabled()'),
  )
}

section('decor sampling loses nothing visible')
check(
  'the glint outlives one DECOR sample (a 320ms sampler can never skip it)',
  TWINKLE_MS > DECOR_TICK_MS,
  `${TWINKLE_MS} > ${DECOR_TICK_MS}`,
)
{
  // For EVERY phase alignment of the 320ms sampler against the twinkle
  // cycle, at least one sample lands inside the glint window.
  let allPhasesSee = true
  for (let phase = 0; phase < DECOR_TICK_MS; phase += 7) {
    let saw = false
    for (let t = phase; t < TWINKLE_CYCLE + phase; t += TWINKLE_TICK_MS) {
      if (twinkleBright(t)) saw = true
    }
    if (!saw) allPhasesSee = false
  }
  check('every sampler phase sees the glint at least once per cycle', allPhasesSee)
}
{
  // READY bucket dwell: the shortest run of any rendered bucket value must
  // be ≥ one DECOR sample, or 320ms sampling would skip rendered steps.
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
  // The dwell law, per primitive: a sampler must never skip a rendered
  // step. READY's min dwell (273ms — the sine's steep midpoint) forbids
  // 320ms sampling; it rides the 160 lattice instead. This check is the
  // ratchet that caught the original DECOR=320 mistake — keep it ≥ the
  // primitive's OWN tick.
  check(
    `READY bucket dwell ≥ its own tick (no rendered step skipped)`,
    minRun >= READY_TICK_MS,
    `min dwell ${minRun}ms ≥ ${READY_TICK_MS}`,
  )
  check(`READY buckets sane`, READY_BUCKETS >= 3)
}

section('typingActivity — the decor pause store')
{
  __typingActivityResetForTest()
  check('initially not typing', isTypingActive() === false)
  let notifications = 0
  const unsub = subscribeTypingActivity(() => notifications++)
  markTypingActivity()
  check('keystroke ⇒ typing active', isTypingActive() === true)
  check('subscribers notified on the false→true edge', notifications === 1)
  markTypingActivity()
  check('repeat keystrokes do not re-notify (edge-triggered)', notifications === 1)
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
  check(`typing releases ~${TYPING_HOLD_MS}ms after the last keystroke`, flipped)
  check('post-release snapshot is false', isTypingActive() === false)
  check('release notified subscribers', notifications === 2)
  unsub()
  __typingActivityResetForTest()
}

section('adoption pins — tiers wired where they belong (source greps)')
{
  const live = readFileSync('src/components/mercury-ui/LiveGlyphs.tsx', 'utf8')
  check(
    'exactly the two DECOR primitives consult the typing pause (ReadyBreath + TwinkleSpark)',
    (live.match(/useTypingPause\(\)/g) ?? []).length === 2,
  )
  const working = live.slice(live.indexOf('export function WorkingGlyph'), live.indexOf('export function AttentionPulse'))
  const attention = live.slice(live.indexOf('export function AttentionPulse'), live.indexOf('const VALUE_GLOW_MS'))
  check('TRUTH tier never pauses: WorkingGlyph ignores typing', !working.includes('useTypingPause'))
  check('TRUTH tier never pauses: AttentionPulse ignores typing', !attention.includes('useTypingPause'))

  const spinner = readFileSync('src/components/Spinner/SpinnerAnimationRow.tsx', 'utf8')
  check(
    'the requesting glimmer rides the FOCAL lane (no off-lattice 50ms clock)',
    spinner.includes('FOCAL_TICK_MS') && !/useAnimationValue\(\s*[^)]*\?\s*50\b/.test(spinner),
  )
  const shimmer = readFileSync('src/components/Spinner/useShimmerAnimation.ts', 'utf8')
  check(
    'useShimmerAnimation is lattice-aligned (FOCAL/WORK, no raw 50/200)',
    shimmer.includes('FOCAL_TICK_MS') && shimmer.includes('WORK_TICK_MS') && !/\?\s*50\s*:\s*200/.test(shimmer),
  )
  const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
  check(
    'the composer input-change chokepoint marks typing activity (T13 S2: the owner edit path)',
    readFileSync('src/input-core/pending-input.ts', 'utf8').includes('markTypingActivity()'),
  )
  const glyphs = readFileSync('src/utils/cockpit/liveGlyphs.ts', 'utf8')
  check(
    'the hierarchy doctrine is documented where the schedule lives',
    glyphs.includes('FOCAL') && glyphs.includes('DECOR') && glyphs.includes('TRUTH'),
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-motion-hierarchy: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ motion-hierarchy — tiers, lattice, typing pause: all pinned')
