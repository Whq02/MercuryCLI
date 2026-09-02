#!/usr/bin/env bun
// ============================================================================
//  scripts/motion/prove-motion-park.ts — invisible surfaces do no
//  animation work, proven on the SHIPPED artifact.
//
//  The law: while a modal CLAIMS the screen (FullscreenLayout motionParked —
//  the opaque pane covers every painted cell below the peek in BOTH claim
//  modes), the covered subtree's animation subscribers park
//  (MotionParkContext through use-animation-value, use-animation-frame and
//  useNowTick) and the presence tail's output-edge dedupe keeps no-change
//  polls from committing. Gate run 2 caught the park never engaging in the
//  inline-chrome world (the old zero-peek condition; peek-2 chrome left every
//  covered decor timer committing ~9 char-identical composes/s forever).
//
//  THE MEASUREMENT WINDOW IS SETTLE-ANCHORED (run-2 re-true): the covering
//  picker's OWN header greets on mount — ProductLockup's title runs the
//  bounded GLOW shimmer for SHIMMER_GREETING_MS on the FOCAL 80ms lane, a
//  lawful VISIBLE color sweep the modal slot's value={false} re-provide
//  deliberately keeps live. The composed tee records characters only, so a
//  color-only sweep reads as "byte-identical" — measuring inside the greeting
//  window red-flagged lawful motion of the covering surface itself, not
//  covered-subtree work. The quiet law is therefore asserted on the covered
//  STEADY state: from mount + SHIMMER_GREETING_MS (+ settle margin) the only
//  composes left are park-blind DATA paints (the header's liveClock second
//  tick — text-changing, never identical), so byte-identical composes ≈ 0. A
//  standing covered-world writer (the unfixed park: READY breath ~2.4
//  commits/s, decor waves) reds this window by construction — measured 14+
//  identical in 6s unfixed, ≤1 fixed. Real time, not authored time: the
//  shimmer's bound is a wall-clock product constant, so the anchor holds at
//  every MERCURY_VSHOT_BUDGET_SCALE.
//
//  Method: one artifact run with motion ON and INK_COMPOSED_TEE; assert the
//  post-settle covered window has ≤3 byte-identical consecutive composes and
//  that composes resume after closing the picker. Plus source locks on the
//  park chain so a refactor that drops any link fails loudly here, not in a
//  live session.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { grabScreens, runArtifactArena } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { SHIMMER_GREETING_MS } from '../../src/utils/cockpit/greetingShimmer.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── motion park under a claims-modal (shipped artifact) ──')

// ── source locks: the park chain stays wired ────────────────────────────────
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
check(
  'use-animation-value reads MotionParkContext',
  src('src/ink/hooks/use-animation-value.ts').includes('MotionParkContext'),
)
check(
  'use-animation-frame reads MotionParkContext',
  src('src/ink/hooks/use-animation-frame.ts').includes('MotionParkContext'),
)
check(
  'useNowTick reads MotionParkContext',
  src('src/components/mercury-ui/components.tsx').includes('MotionParkContext'),
)
{
  const fsl = src('src/components/FullscreenLayout.tsx')
  check(
    'FullscreenLayout provides the park on the always-mounted root',
    fsl.includes('MotionParkContext.Provider value={motionParked}'),
  )
  check(
    'the modal slot re-provides false (its own primitives stay live)',
    fsl.includes('MotionParkContext.Provider value={false}'),
  )
}

// ── the behavioral law on the built artifact ────────────────────────────────
const teeDir = mkdtempSync(join(tmpdir(), 'glide-park-'))
const tee = join(teeDir, 'tee.jsonl')
// The picker holds long enough for its OWN greeting shimmer to settle
// (SHIMMER_GREETING_MS real time from mount) plus a full 6s quiet window
// before the authored ESC — at scale 1 the modal is up ~7s→26s and the
// quiet window ends ~24.7s; a stretched movie only moves the ESC later.
const run = await runArtifactArena({
  turns: [{ kind: 'text', text: 'REPLY-PARK done.' }],
  sends: ['3500:warm up', '4300:\\r', '6000:/model', '6800:\\r', '26000:\\x1b'],
  seconds: 30,
  keep: true,
  extraEnv: { MERCURY_LIVE_GLYPHS: '1', INK_COMPOSED_TEE: tee },
})

interface TeeRec {
  f: number
  ts: number
  rows: string[]
}
const recs: TeeRec[] = []
for (const line of readFileSync(tee, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const j = JSON.parse(line) as TeeRec
    if (typeof j.f === 'number' && Array.isArray(j.rows)) recs.push(j)
  } catch {
    /* partial tail line */
  }
}
const isModal = (r: TeeRec): boolean => r.rows.some(row => row.startsWith('▔▔▔▔'))
const modal = recs.filter(isModal)
check('the picker opened as a claims-modal (▔ frames captured)', modal.length >= 1, `frames=${modal.length}`)

if (modal.length >= 1) {
  const openTs = modal[0]!.ts
  // Covered STEADY state — settle-anchored (header story): the first modal
  // frame is the picker's mount, its greeting shimmer settles at
  // SHIMMER_GREETING_MS real time, and 1.5s of margin covers the ease-out
  // tail + the settle latch effect. Everything in the next 6s is either a
  // park-blind DATA paint (text-changing) or covered-subtree waste.
  const quietFrom = openTs + SHIMMER_GREETING_MS + 1500
  const quietTo = quietFrom + 6000
  const win = recs.filter(r => r.ts >= quietFrom && r.ts <= quietTo)
  let identical = 0
  for (let i = 1; i < win.length; i++) {
    if (win[i]!.rows.join('\n') === win[i - 1]!.rows.join('\n')) identical++
  }
  check(
    'the settled covered window is quiet (≤3 byte-identical composes in 6s; unfixed 14+)',
    identical <= 3,
    `identical=${identical} composes=${win.length}`,
  )
  // Resume anchor retune: the covered window is
  // now quiet enough that the OPEN modal composes only its entry frames —
  // the last modal compose sits at open, not at close, so anchoring the
  // resume window there measured the deliberately-quiet covered period
  // (resumed=0 while motion in fact resumed). Anchor on the close repaint:
  // the first non-modal compose after the quiet window and before the
  // scene's ESC can only be the close. The scene's send schedule is the
  // time contract here.
  const closeFrame = recs.find(r => r.ts > quietTo && !isModal(r))
  check('the picker closed (a non-modal compose follows coverage)', closeFrame !== undefined)
  if (closeFrame) {
    const resumed = recs.filter(r => r.ts >= closeFrame.ts && r.ts <= closeFrame.ts + 3000)
    check('motion resumes after close (≥2 composes in 3s)', resumed.length >= 2, `resumed=${resumed.length}`)
  }
}

// The picker itself must stay LIVE while everything beneath parks: the modal
// slot re-provides false, so its list cursor/glyphs render normally — pin the
// visible outcome (the picker frame is intact at snapshot time).
const [snap] = grabScreens(run, 120, 40, [S(12000)])
check('the covered-window picker frame is intact', snap!.rows.some(r => r.startsWith('▔▔▔▔')))

run.cleanup()
rmSync(teeDir, { recursive: true, force: true })

console.log(failures === 0 ? '✅ motion-park GREEN' : `❌ motion-park RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
