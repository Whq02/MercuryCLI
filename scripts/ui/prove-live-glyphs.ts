#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-live-glyphs.ts
//  PROOF: the standing-chrome liveness layer (WorkingGlyph rotation ·
//  AttentionPulse wave · ValueGlow flash) is correct WITHOUT racing a live
//  PTY. The schedule + gate live in the React-free utils/cockpit/liveGlyphs
//  module precisely so they're provable here:
//    • frame 0 IS the static GLYPH.inProgress ◐ — every degraded state
//      (reduced-motion · =0 · bare-stamp · inactive) renders the exact glyph the
//      surface rendered before the primitive existed;
//    • the rotation visits all four quarter-moon frames, geometric shapes
//      only (U+25D0 family — never emoji);
//    • the attention wave is a smooth bounded 0→1→0 that STARTS at 0 (the
//      pulse eases in from FAINT, never snaps);
//    • the gate folds FALSE off-fork and on the explicit =0 opt-out.
//  Adoption + no-new-hex pins are source greps; the dist grep pins the frames
//  into the built binary (host-vs-binary lesson).
//  Run: ~/.bun/bin/bun run scripts/ui/prove-live-glyphs.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import {
  ATTENTION_BUCKETS,
  ATTENTION_PERIOD,
  ATTENTION_TICK_MS,
  attentionBucket,
  attentionWave,
  liveGlyphsEnabled,
  READY_BUCKETS,
  READY_PERIOD,
  readyBucket,
  readyWave,
  SETTLE_MS,
  TWINKLE_CYCLE,
  TWINKLE_MS,
  twinkleBright,
  WORK_FRAMES,
  WORK_TICK_MS,
  workGlyphForTime,
} from '../../src/utils/cockpit/liveGlyphs.js'
import { GLYPH, displayWidth } from '../../src/components/mercury-ui/glyphs.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const setStamp = (on: boolean) => {
  ;(globalThis as Record<string, unknown>)['MACRO'] = {
    VERSION: on ? '1.0.0' : '0.0.0-src',
  }
}

section('WORK rotation — static-degradation invariant + full cycle')
check(
  'frame 0 IS GLYPH.inProgress (static fallback is byte-compatible)',
  WORK_FRAMES[0] === GLYPH.inProgress,
  `frame0=${WORK_FRAMES[0]} glyph=${GLYPH.inProgress}`,
)
check('workGlyphForTime(0) is frame 0', workGlyphForTime(0) === WORK_FRAMES[0])
{
  const seen = new Set<string>()
  for (let t = 0; t < WORK_TICK_MS * WORK_FRAMES.length; t += WORK_TICK_MS) {
    seen.add(workGlyphForTime(t))
  }
  check(
    'one period visits ALL frames exactly once each tick',
    seen.size === WORK_FRAMES.length,
    `${[...seen].join('')}`,
  )
}
check(
  'cycle wraps (t = 4 ticks ⇒ frame 0 again)',
  workGlyphForTime(WORK_TICK_MS * WORK_FRAMES.length) === WORK_FRAMES[0],
)
check(
  'negative/garbage time degrades to a valid frame (never undefined)',
  WORK_FRAMES.includes(workGlyphForTime(-1) as (typeof WORK_FRAMES)[number]),
)
check(
  'all frames are single-codepoint U+25D0-family geometric shapes (never emoji)',
  WORK_FRAMES.every(f => {
    const cp = f.codePointAt(0) ?? 0
    return [...f].length === 1 && cp >= 0x25d0 && cp <= 0x25d3
  }),
)

section('ATTENTION wave — bounded, eased-in, quantized')
check('wave(0) starts at 0 (eases in from FAINT, no AMBER snap)', attentionWave(0) < 0.001)
check(
  'wave peaks ≈1 at half period',
  Math.abs(attentionWave(ATTENTION_PERIOD / 2) - 1) < 0.001,
)
{
  let ok = true
  for (let t = 0; t <= ATTENTION_PERIOD * 2; t += ATTENTION_TICK_MS / 2) {
    const w = attentionWave(t)
    if (!(w >= 0 && w <= 1)) ok = false
  }
  check('wave bounded 0..1 across two periods', ok)
}
{
  let ok = true
  for (let t = -ATTENTION_PERIOD; t <= ATTENTION_PERIOD * 2; t += 37) {
    const b = attentionBucket(t)
    if (!(Number.isInteger(b) && b >= 0 && b <= ATTENTION_BUCKETS)) ok = false
  }
  check(`bucket ∈ [0, ${ATTENTION_BUCKETS}] (incl. negative time)`, ok)
}
check('bucket(0) is 0 (the settled FAINT end)', attentionBucket(0) === 0)

section('READY breath — the ambient alive-at-rest tier (caret)')
check('ready wave(0) starts at 0 (swells in from the deep end, no snap)', readyWave(0) < 0.001)
check(
  'ready wave peaks ≈1 at half period',
  Math.abs(readyWave(READY_PERIOD / 2) - 1) < 0.001,
)
{
  let ok = true
  for (let t = -READY_PERIOD; t <= READY_PERIOD * 2; t += 53) {
    const w = readyWave(t)
    const b = readyBucket(t)
    if (!(w >= 0 && w <= 1)) ok = false
    if (!(Number.isInteger(b) && b >= 0 && b <= READY_BUCKETS)) ok = false
  }
  check(`ready wave bounded 0..1, bucket ∈ [0, ${READY_BUCKETS}] (incl. negative time)`, ok)
}
check(
  'READY is SLOWER than ATTENTION (presence must never read as a demand)',
  READY_PERIOD > ATTENTION_PERIOD,
  `${READY_PERIOD} > ${ATTENTION_PERIOD}`,
)

section('TWINKLE — the standing brand glint')
check(
  'twinkleBright(0) is FALSE — frame 0 IS the static ✶ (degradation invariant)',
  twinkleBright(0) === false,
)
{
  let brightMs = 0
  const step = 10
  for (let t = 0; t < TWINKLE_CYCLE; t += step) if (twinkleBright(t)) brightMs += step
  check('a glint window exists', brightMs > 0, `${brightMs}ms`)
  check(
    'glint duty cycle ≤ 5% (a glint, not a strobe)',
    brightMs <= TWINKLE_CYCLE * 0.05,
    `${brightMs}/${TWINKLE_CYCLE}ms`,
  )
  check(
    'glint width ≈ TWINKLE_MS',
    Math.abs(brightMs - TWINKLE_MS) <= step * 2,
    `${brightMs} vs ${TWINKLE_MS}`,
  )
}
check('negative time never glints undefined', typeof twinkleBright(-1234) === 'boolean')

section('SETTLE + the spark family — the ember-settle event')
check('SETTLE_MS is one readable beat (200..600ms)', SETTLE_MS >= 200 && SETTLE_MS <= 600, `${SETTLE_MS}`)
check(
  'spark family codepoints are the authored stars (U+2736/2726/2727)',
  GLYPH.spark === '✶' && GLYPH.sparkBright === '✦' && GLYPH.sparkFaint === '✧',
)
check(
  'spark family is width-1 single-codepoint under the canonical model',
  [GLYPH.spark, GLYPH.sparkBright, GLYPH.sparkFaint].every(
    g => [...g].length === 1 && displayWidth(g) === 1,
  ),
)

section('gate polarity — default-on')
{
  const saved = process.env.MERCURY_LIVE_GLYPHS
  setStamp(true)
  delete process.env.MERCURY_LIVE_GLYPHS
  check('fork + unset ⇒ enabled', liveGlyphsEnabled() === true)
  process.env.MERCURY_LIVE_GLYPHS = '0'
  check("fork + '0' ⇒ disabled (hard-off)", liveGlyphsEnabled() === false)
  delete process.env.MERCURY_LIVE_GLYPHS
 // The gate is stamp-independent.
  setStamp(false)
  check('bare stamp ⇒ STILL enabled (stamp-independence)', liveGlyphsEnabled() === true)
  setStamp(true)
  if (saved !== undefined) process.env.MERCURY_LIVE_GLYPHS = saved
}

section('adoption + hygiene pins (source greps)')
{
  const live = readFileSync('src/components/mercury-ui/LiveGlyphs.tsx', 'utf8')
  check(
    'LiveGlyphs uses useAnimationValue (derived-value bail — equal frames never commit)',
    live.includes('useAnimationValue'),
  )
  check(
    'AttentionPulse lerps EXISTING tokens via lerpHex (no new hex)',
    live.includes('lerpHex(FAINT, AMBER'),
  )
  check(
    'no raw hex literals declared in LiveGlyphs (tokens only)',
    !/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(live),
  )
  check(
    'both primitives honor prefersReducedMotion',
    (live.match(/prefersReducedMotion/g) ?? []).length >= 2,
  )
  const rail = readFileSync('src/components/HelmTelemetryRail.tsx', 'utf8')
  check(
    'HelmTelemetryRail adopts WorkingGlyph + AttentionPulse + ValueGlow',
    rail.includes('WorkingGlyph') && rail.includes('AttentionPulse') && rail.includes('ValueGlow'),
  )
  check(
    'rail countdowns ride a tick, not a render-frozen Date.now()',
    // The tick tightened to 1s while a console ask is in flight (elapsed
    // counter movement) and stays 30s otherwise — still a tick, never a
    // render-frozen Date.now().
    rail.includes('useNowTick(consolePending ? 1000 : 30_000)'),
  )
  const deck = readFileSync('src/components/DeckPane.tsx', 'utf8')
  check(
    'DeckPane adopts WorkingGlyph + AttentionPulse',
    deck.includes('WorkingGlyph') && deck.includes('AttentionPulse'),
  )
  check('deck countdowns ride the same tick', deck.includes('useNowTick(30_000)'))
  const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8')
  check('MercuryFrame turn counter wears ValueGlow', frame.includes('ValueGlow'))
  const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
  check('MERCURY_LIVE_GLYPHS registered in flagRegistry', reg.includes("'MERCURY_LIVE_GLYPHS'"))
  // Strand-reset: every two-state latch (ValueGlow, useSettleFlash) RESETS on
  // its non-flash effect paths — a mid-flash effect re-run has already had its
  // un-latch timer cleared by React's cleanup, so without the reset the flash
  // would strand ON (a ✶ masquerading as a state glyph).
  check(
    'two-state latches reset on non-flash paths (no stranded glow)',
    (live.match(/setGlowing\(false\)\s*\n\s*return/g) ?? []).length >= 1 &&
      (live.match(/setFlash\(false\)\s*\n\s*return/g) ?? []).length >= 1,
  )
}

section('adoption — the alive-REPL pass (ember-settle · breath · glint · nudge)')
{
  const loader = readFileSync('src/components/ToolUseLoader.tsx', 'utf8')
  check(
    'ToolUseLoader rotates via the SHARED schedule (workGlyphForTime) while running',
    loader.includes('workGlyphForTime(breathTime)'),
  )
  check(
    'ToolUseLoader blooms GLYPH.spark on the live resolve edge (useSettleFlash)',
    loader.includes('useSettleFlash(') && loader.includes('GLYPH.spark'),
  )
  check(
    // The spark consumes the DERIVED accent-bloom
    // (tokens.accentSoft — crab = authored BELLY byte-equal, other critters
    // bloom their own hue) — still never a status hue.
    'the spark is accentSoft-toned (the derived bloom) — never a status hue',
    loader.includes('color={accentSoft}'),
  )
  check(
    'reads stay quiet — the spark branch excludes isRead',
    /!isRead && settleFlash/.test(loader),
  )
  const caret = readFileSync('src/components/PromptInput/PromptInputModeIndicator.tsx', 'utf8')
  check(
    'the prompt caret wears ReadyBreath, armed only when idle AND empty',
    caret.includes('ReadyBreath') && caret.includes('const breathing = !isLoading && inputEmpty'),
  )
  const promptInput = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
  check(
    'PromptInput threads the LIVE buffer emptiness to the caret',
    promptInput.includes("inputEmpty={input === ''}"),
  )
  const rollup = readFileSync('src/components/MercuryTurnRollup.tsx', 'utf8')
  check(
    'MercuryTurnRollup tallies wear ValueGlow (files + lines; tool-count stays quiet)',
    (rollup.match(/<ValueGlow /g) ?? []).length === 2,
  )
  const assets = readFileSync('src/components/mercury-ui/assets.tsx', 'utf8')
  check('the inline Sigil glints via TwinkleSpark', assets.includes('<TwinkleSpark color={accent} />'))
  // CursorCell adoption breadth: every navigable command-center list points
  // the same nudging cursor — either hand-rolled or via the NavigablePanes
  // shell (whose PaneRow hosts CursorCell for every board it renders).
  // TicketsView moved onto NavigablePanes in the interaction-finish pass, so
  // its cursor now rides the framework (counted via the <NavigablePanes tag).
 // ChronicleView left the estate with the specimen
  //  purge — /chronicle now aliases the live /memory Centre. RouteView left
  //  with the /route account-routing surface — account-slot simplification,
  //  operator ruling. TicketsView + MultiplayerView left with the
  //  multiplayer estate's retirement; the floor retunes to the surviving three.)
  const cursorFiles = [
    'src/commands/console/console.tsx',
    'src/commands/health/HealthCertificate.tsx',
    'src/components/mercury-ui/parity/DaemonSupervisorView.tsx',
  ]
  const adopted = cursorFiles.filter(f => {
    const src = readFileSync(f, 'utf8')
    return src.includes('<CursorCell ') || src.includes('<NavigablePanes')
  }).length
  check(`CursorCell adopted at ≥3 navigable lists`, adopted >= 3, `${adopted}/${cursorFiles.length}`)
  check(
    'the NavigablePanes shell itself hosts CursorCell (the framework cursor)',
    readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8').includes('<CursorCell '),
  )
}

section('dist — the built binary carries the rotation (host-vs-binary)')
{
  let dist = ''
  try {
    dist = readFileSync('dist/mercury.mjs', 'utf8')
  } catch {
    // no dist built — an honest skip, the gate's Phase-0 prebuild covers it
  }
  if (dist) {
    check('dist carries the quarter-moon frame set', dist.includes('◓') && dist.includes('◒'))
    check('dist carries the gate env read', dist.includes('MERCURY_LIVE_GLYPHS'))
    check('dist carries the spark family (✧ is the new-char sentinel)', dist.includes('✧'))
  } else {
    console.log('  [SKIP] dist/mercury.mjs not present (run a full build first)')
  }
}

section('CACHED MOTION FRAMES — authored at module scope, zero idle cost')
{
  // The Crush mechanic, absorbed: motion frames are AUTHORED TABLES built at
  // cache-generation (module-load) time — the animation loop swaps an index,
  // it never constructs frames or styles. Idle/off states arm ZERO timers.
  // (The retired logo pins left with the mascot family —
  // the file was deleted before this lane; mercury-ui/AnimatedCritterArt.tsx
  // is the successor with its own design. The animation-gate pins below
  // still bind the live hook.)
  const anim = readFileSync('src/ink/hooks/use-animation-value.ts', 'utf8')
  check(
    'offscreen / parked / motion-off all fold to inactive (one gate)',
    anim.includes('const active = isVisible && !parked && intervalMs !== null'),
  )
  check(
    'inactive arms NO clock subscription (the effect returns first)',
    anim.includes('if (!clock || !active) return'),
  )
  check(
    'same-interval subscribers sample the SAME absolute bucket (commits batch)',
    anim.includes('Math.floor(clock.now() / intervalMs!)'),
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-live-glyphs: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ live-glyphs — schedule, gate, adoption, hygiene: all pinned')
