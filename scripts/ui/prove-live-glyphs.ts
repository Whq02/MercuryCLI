#!/usr/bin/env bun
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
} from '../../src/screen/cockpit/liveGlyphs.js'
import { GLYPH, displayWidth } from '../../src/screen/theme/glyphs.js'
import { getFlagSpec } from '../../src/platform/substrate/flagRegistry.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
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
  'make the first entry of WORK_FRAMES in src/screen/cockpit/liveGlyphs.ts equal GLYPH.inProgress in src/screen/theme/glyphs.ts',
)
check('workGlyphForTime(0) is frame 0', workGlyphForTime(0) === WORK_FRAMES[0], '', 'workGlyphForTime in src/screen/cockpit/liveGlyphs.ts must return WORK_FRAMES[0] at time 0')
{
  const seen = new Set<string>()
  for (let t = 0; t < WORK_TICK_MS * WORK_FRAMES.length; t += WORK_TICK_MS) {
    seen.add(workGlyphForTime(t))
  }
  check(
    'one period visits ALL frames exactly once each tick',
    seen.size === WORK_FRAMES.length,
    `${[...seen].join('')}`,
    'workGlyphForTime in src/screen/cockpit/liveGlyphs.ts must step to the next WORK_FRAMES entry every WORK_TICK_MS, with no repeated or skipped frame',
  )
}
check(
  'cycle wraps (t = 4 ticks ⇒ frame 0 again)',
  workGlyphForTime(WORK_TICK_MS * WORK_FRAMES.length) === WORK_FRAMES[0],
  '',
  'workGlyphForTime in src/screen/cockpit/liveGlyphs.ts must wrap modulo WORK_FRAMES.length',
)
check(
  'negative/garbage time degrades to a valid frame (never undefined)',
  WORK_FRAMES.includes(workGlyphForTime(-1) as (typeof WORK_FRAMES)[number]),
  '',
  'workGlyphForTime in src/screen/cockpit/liveGlyphs.ts must map a negative time to a valid WORK_FRAMES index',
)
check(
  'all frames are single-codepoint U+25D0-family geometric shapes (never emoji)',
  WORK_FRAMES.every(f => {
    const cp = f.codePointAt(0) ?? 0
    return [...f].length === 1 && cp >= 0x25d0 && cp <= 0x25d3
  }),
  '',
  'WORK_FRAMES in src/screen/cockpit/liveGlyphs.ts must hold only single-codepoint glyphs from U+25D0 to U+25D3',
)

section('ATTENTION wave — bounded, eased-in, quantized')
check('wave(0) starts at 0 (eases in from FAINT, no AMBER snap)', attentionWave(0) < 0.001, '', 'attentionWave in src/screen/cockpit/liveGlyphs.ts must return about 0 at time 0')
check(
  'wave peaks ≈1 at half period',
  Math.abs(attentionWave(ATTENTION_PERIOD / 2) - 1) < 0.001,
  '',
  'attentionWave in src/screen/cockpit/liveGlyphs.ts must reach 1 at ATTENTION_PERIOD / 2',
)
{
  let ok = true
  for (let t = 0; t <= ATTENTION_PERIOD * 2; t += ATTENTION_TICK_MS / 2) {
    const w = attentionWave(t)
    if (!(w >= 0 && w <= 1)) ok = false
  }
  check('wave bounded 0..1 across two periods', ok, '', 'attentionWave in src/screen/cockpit/liveGlyphs.ts must stay within 0 and 1 at every sampled time')
}
{
  let ok = true
  for (let t = -ATTENTION_PERIOD; t <= ATTENTION_PERIOD * 2; t += 37) {
    const b = attentionBucket(t)
    if (!(Number.isInteger(b) && b >= 0 && b <= ATTENTION_BUCKETS)) ok = false
  }
  check(`bucket ∈ [0, ${ATTENTION_BUCKETS}] (incl. negative time)`, ok, '', 'attentionBucket in src/screen/cockpit/liveGlyphs.ts must return an integer from 0 to ATTENTION_BUCKETS for every time, negative included')
}
check('bucket(0) is 0 (the settled FAINT end)', attentionBucket(0) === 0, '', 'attentionBucket in src/screen/cockpit/liveGlyphs.ts must return 0 at time 0')

section('READY breath — the ambient alive-at-rest tier (caret)')
check('ready wave(0) starts at 0 (swells in from the deep end, no snap)', readyWave(0) < 0.001, '', 'readyWave in src/screen/cockpit/liveGlyphs.ts must return about 0 at time 0')
check(
  'ready wave peaks ≈1 at half period',
  Math.abs(readyWave(READY_PERIOD / 2) - 1) < 0.001,
  '',
  'readyWave in src/screen/cockpit/liveGlyphs.ts must reach 1 at READY_PERIOD / 2',
)
{
  let ok = true
  for (let t = -READY_PERIOD; t <= READY_PERIOD * 2; t += 53) {
    const w = readyWave(t)
    const b = readyBucket(t)
    if (!(w >= 0 && w <= 1)) ok = false
    if (!(Number.isInteger(b) && b >= 0 && b <= READY_BUCKETS)) ok = false
  }
  check(`ready wave bounded 0..1, bucket ∈ [0, ${READY_BUCKETS}] (incl. negative time)`, ok, '', 'readyWave must stay within 0 and 1 and readyBucket must be an integer from 0 to READY_BUCKETS at every time; both are in src/screen/cockpit/liveGlyphs.ts')
}
check(
  'READY is SLOWER than ATTENTION (presence must never read as a demand)',
  READY_PERIOD > ATTENTION_PERIOD,
  `${READY_PERIOD} > ${ATTENTION_PERIOD}`,
  'raise READY_PERIOD above ATTENTION_PERIOD in src/screen/cockpit/liveGlyphs.ts',
)

section('TWINKLE — the standing brand glint')
check(
  'twinkleBright(0) is FALSE — frame 0 IS the static ✶ (degradation invariant)',
  twinkleBright(0) === false,
  '',
  'twinkleBright in src/screen/cockpit/liveGlyphs.ts must return false at time 0',
)
{
  let brightMs = 0
  const step = 10
  for (let t = 0; t < TWINKLE_CYCLE; t += step) if (twinkleBright(t)) brightMs += step
  check('a glint window exists', brightMs > 0, `${brightMs}ms`, 'twinkleBright in src/screen/cockpit/liveGlyphs.ts must return true for some time inside TWINKLE_CYCLE')
  check(
    'glint duty cycle ≤ 5% (a glint, not a strobe)',
    brightMs <= TWINKLE_CYCLE * 0.05,
    `${brightMs}/${TWINKLE_CYCLE}ms`,
    'shorten the bright window or lengthen TWINKLE_CYCLE in src/screen/cockpit/liveGlyphs.ts',
  )
  check(
    'glint width ≈ TWINKLE_MS',
    Math.abs(brightMs - TWINKLE_MS) <= step * 2,
    `${brightMs} vs ${TWINKLE_MS}`,
    'twinkleBright in src/screen/cockpit/liveGlyphs.ts must stay true for about TWINKLE_MS per cycle',
  )
}
check('negative time never glints undefined', typeof twinkleBright(-1234) === 'boolean', '', 'twinkleBright in src/screen/cockpit/liveGlyphs.ts must return a boolean for a negative time')

section('SETTLE + the spark family — the ember-settle event')
check('SETTLE_MS is one readable beat (200..600ms)', SETTLE_MS >= 200 && SETTLE_MS <= 600, `${SETTLE_MS}`, 'set SETTLE_MS in src/screen/cockpit/liveGlyphs.ts between 200 and 600')
check(
  'spark family codepoints are the authored stars (U+2736/2726/2727)',
  GLYPH.spark === '✶' && GLYPH.sparkBright === '✦' && GLYPH.sparkFaint === '✧',
  '',
  'restore GLYPH.spark, GLYPH.sparkBright and GLYPH.sparkFaint in src/screen/theme/glyphs.ts to U+2736, U+2726 and U+2727',
)
check(
  'spark family is width-1 single-codepoint under the canonical model',
  [GLYPH.spark, GLYPH.sparkBright, GLYPH.sparkFaint].every(
    g => [...g].length === 1 && displayWidth(g) === 1,
  ),
  '',
  'the spark glyphs in src/screen/theme/glyphs.ts must be one codepoint and one column wide under displayWidth',
)

section('gate polarity — default-on')
{
  const saved = process.env.MERCURY_LIVE_GLYPHS
  setStamp(true)
  delete process.env.MERCURY_LIVE_GLYPHS
  check('fork + unset ⇒ enabled', liveGlyphsEnabled() === true, '', 'liveGlyphsEnabled in src/screen/cockpit/liveGlyphs.ts must be true when MERCURY_LIVE_GLYPHS is unset')
  process.env.MERCURY_LIVE_GLYPHS = '0'
  check("fork + '0' ⇒ disabled (hard-off)", liveGlyphsEnabled() === false, '', 'liveGlyphsEnabled in src/screen/cockpit/liveGlyphs.ts must be false when MERCURY_LIVE_GLYPHS is 0')
  delete process.env.MERCURY_LIVE_GLYPHS
  setStamp(false)
  check('bare stamp ⇒ STILL enabled (stamp-independence)', liveGlyphsEnabled() === true, '', 'liveGlyphsEnabled in src/screen/cockpit/liveGlyphs.ts must not read the version stamp, only MERCURY_LIVE_GLYPHS')
  setStamp(true)
  if (saved !== undefined) process.env.MERCURY_LIVE_GLYPHS = saved
}

section('adoption + hygiene pins (source greps)')
{
  check('MERCURY_LIVE_GLYPHS registered in flagRegistry', getFlagSpec('MERCURY_LIVE_GLYPHS') !== undefined, '', 'register MERCURY_LIVE_GLYPHS in the flag registry read by getFlagSpec in the flag registry (FLAG_REGISTRY)')
}


section('dist — the built binary carries the rotation (host-vs-binary)')
{
  let dist = ''
  try {
    dist = readFileSync('dist/mercury.mjs', 'utf8')
  } catch {
  }
  if (dist) {
    check('dist carries the quarter-moon frame set', dist.includes('◓') && dist.includes('◒'), '', 'dist/mercury.mjs is stale or lacks the work frames from src/screen/cockpit/liveGlyphs.ts; rebuild with bun run build.ts')
    check('dist carries the gate env read', dist.includes('MERCURY_LIVE_GLYPHS'), '', 'dist/mercury.mjs is stale or lacks the MERCURY_LIVE_GLYPHS read from src/screen/cockpit/liveGlyphs.ts; rebuild with bun run build.ts')
    check('dist carries the spark family (✧ is the new-char sentinel)', dist.includes('✧'), '', 'dist/mercury.mjs is stale or lacks the spark glyphs from src/screen/theme/glyphs.ts; rebuild with bun run build.ts')
  } else {
    console.log('  [SKIP] dist/mercury.mjs not present (run a full build first)')
  }
}


console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-live-glyphs: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ live-glyphs — schedule, gate, adoption, hygiene: all pinned')
