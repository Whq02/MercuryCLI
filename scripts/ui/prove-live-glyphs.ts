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
} from '../../src/utils/cockpit/liveGlyphs.js'
import { GLYPH, displayWidth } from '../../src/utils/glyphs.js'
import { getFlagSpec } from '../../src/substrate/flagRegistry.js'

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
  setStamp(false)
  check('bare stamp ⇒ STILL enabled (stamp-independence)', liveGlyphsEnabled() === true)
  setStamp(true)
  if (saved !== undefined) process.env.MERCURY_LIVE_GLYPHS = saved
}

section('adoption + hygiene pins (source greps)')
{
  check('MERCURY_LIVE_GLYPHS registered in flagRegistry', getFlagSpec('MERCURY_LIVE_GLYPHS') !== undefined)
}


section('dist — the built binary carries the rotation (host-vs-binary)')
{
  let dist = ''
  try {
    dist = readFileSync('dist/mercury.mjs', 'utf8')
  } catch {
  }
  if (dist) {
    check('dist carries the quarter-moon frame set', dist.includes('◓') && dist.includes('◒'))
    check('dist carries the gate env read', dist.includes('MERCURY_LIVE_GLYPHS'))
    check('dist carries the spark family (✧ is the new-char sentinel)', dist.includes('✧'))
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
