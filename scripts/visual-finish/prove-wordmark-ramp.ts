#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-finish/prove-wordmark-ramp.ts — the in-app wordmark estate's
//  continuous-material laws.
//
//  §1 bigWordmarkRows stays the authored art: three EQUAL-WIDTH rows (42
//     cells — every letter pads to its own width on every row, 2-col gaps
//     included), half-block charset only. The ramp must never change a byte
//     of the letterforms (the capture-level byte-identity leg rides the
//     visual manifest's split grid/style digests).
//
//  §2 the ART-SPACE ramp law: painting each row with rampSegments(row, ramp)
//     yields SAME-X-SAME-COLOUR across all three rows, gaps advance the
//     sample (no per-letter restart), and every row's per-cell walk equals
//     the solid 42-cell walk — one shared material, by construction.
//
//  §3 wordmarkForm is the ONE banner/compact law (D8): the full 47/48 ×
//     33/34/35 truth table, and the rows-only ALTERNATIVE DISAGREES
//     on the tall-narrow cells — the split-selector defect can't return
//     silently.
//
//  §4 the R5 resolution law: a non-crab warm-red accent DERIVES its own
//     3-stop ramp through resolveMercuryTokens — the flat collapse is absent
//     at the resolver level; reduced families still collapse to one stop.
//
//  Unicode is spelled as escapes where non-ASCII (the raw-glyph law).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import {
  bigWordmarkRows,
  wordmarkForm,
} from '../../src/components/mercury-ui/assets.tsx'
import { rampSegments, type RampSegment } from '../../src/components/mercury-ui/focalRamp.ts'
import { TERRA } from '../../src/components/mercuryPalette.ts'

/** A non-crab warm-red accent sample (the retired storm-register hue). */
const WARM_RED_SAMPLE = '#DE4A35'
import { resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const cells = (segs: RampSegment[]): string[] => segs.flatMap(s => [...s.text].map(() => s.color))

t.section('§1 — the authored art is intact')
{
  const rows = bigWordmarkRows()
  t.check('three half-block rows', rows.length === 3, String(rows.length))
  const widths = rows.map(r => r.length)
  t.check(
    'every row is the same 42-cell width (equal-width by construction)',
    widths.every(w => w === 42),
    widths.join(','),
  )
  const charset = /^[▀▄█ ]+$/ // ▀ ▄ █ space
  t.check(
    'letterforms use only the half-block charset',
    rows.every(r => charset.test(r)),
    JSON.stringify(rows),
  )
}

t.section('§2 — one shared art-space material')
{
  const ramp = resolveMercuryTokens('dark', TERRA).focalRamp
  const rows = bigWordmarkRows()
  const painted = rows.map(r => cells(rampSegments(r, ramp)))
  const solid = cells(rampSegments('M'.repeat(42), ramp))
  t.check(
    'every row cell-walks the SAME colors as the solid 42-cell walk (gaps advance, no per-letter restart)',
    painted.every(p => JSON.stringify(p) === JSON.stringify(solid)),
    `row0[0..3]=${painted[0]?.slice(0, 4).join(',')}`,
  )
  const sameX = painted[0]?.every(
    (c, x) => c === painted[1]?.[x] && c === painted[2]?.[x],
  )
  t.check('same-x-same-colour across all three rows', sameX === true, 'per-cell agreement')
  t.check(
    'the banner paints a continuous walk (more than the 3 stop colors)',
    new Set(painted[0]).size > 3,
    `${new Set(painted[0]).size} distinct`,
  )
  const flat = resolveMercuryTokens('dark-ansi', TERRA).focalRamp
  const flatPainted = rows.map(r => rampSegments(r, flat))
  t.check(
    'a reduced family collapses every row to ONE flat segment',
    flatPainted.every(p => p.length === 1 && p[0]?.color === TERRA),
    JSON.stringify(flatPainted.map(p => p.length)),
  )
}

t.section('§3 — wordmarkForm: the ONE banner/compact law (D8)')
{
  const table: Array<[number, number, 'banner' | 'compact']> = [
    [47, 33, 'compact'],
    [47, 34, 'compact'],
    [47, 35, 'compact'],
    [48, 33, 'compact'],
    [48, 34, 'banner'],
    [48, 35, 'banner'],
  ]
  for (const [cols, rows, want] of table) {
    t.check(
      `wordmarkForm(${cols}, ${rows}) = ${want}`,
      wordmarkForm(cols, rows) === want,
      wordmarkForm(cols, rows),
    )
  }
  // The split-selector defect: a rows-only law says banner at 47x34 —
  // the tall-narrow terminal that wrapped the 42-cell banner. The variant
  // must DISAGREE with the unified law exactly there, or this leg goes red
  // and the split can never silently return.
  const rowsOnly = (rows: number): 'banner' | 'compact' => (rows >= 34 ? 'banner' : 'compact')
  t.check(
    'the historical rows-only variant disagrees at 47x34/47x35 (the discriminator)',
    rowsOnly(34) !== wordmarkForm(47, 34) && rowsOnly(35) !== wordmarkForm(47, 35),
    `rows-only says ${rowsOnly(34)}, unified says ${wordmarkForm(47, 34)}`,
  )
  // BOTH home states consume the ONE selector, and the raw form law lives
  // nowhere else in the home (a re-inlined `rows >= 34` would re-split D8).
  const home = readFileSync('src/components/MercuryHome.tsx', 'utf8')
  const callSites = (home.match(/wordmarkForm\(/g) ?? []).length
  t.check(
    'MercuryBrandRow AND MercuryHome consume wordmarkForm (>=2 call sites)',
    callSites >= 2,
    `${callSites} call sites`,
  )
  t.check(
    'no raw `>= 34` form law survives in MercuryHome (one owner)',
    !/>=\s*34/.test(home),
    'clean',
  )
}

t.section('§4 — R5: a non-crab warm-red accent derives its own ramp')
{
  const warm = resolveMercuryTokens('dark', WARM_RED_SAMPLE)
  t.check(
    'the warm-red accent derives a 3-stop ramp of its own (accent first — no flat collapse)',
    warm.focalRamp.length === 3 && warm.focalRamp[0] === WARM_RED_SAMPLE,
    warm.focalRamp.join(' '),
  )
  t.check(
    "the warm-red bloom is DERIVED from the accent (never the crab's BELLY)",
    warm.focalRamp[1] === warm.accentSoft && warm.focalRamp[1] !== resolveMercuryTokens('dark', TERRA).focalRamp[1],
    warm.focalRamp.join(' '),
  )
  const reduced = resolveMercuryTokens('dark-ansi', WARM_RED_SAMPLE)
  t.check(
    'reduced families still collapse the warm-red ramp flat',
    reduced.focalRamp.length === 1 && reduced.focalRamp[0] === WARM_RED_SAMPLE,
    reduced.focalRamp.join(' '),
  )
  // pin: the version tail rides the token layer, never the fixed FAINT —
  // the one palette literal the token-aware Wordmark would otherwise carry.
  const assets = readFileSync('src/components/mercury-ui/assets.tsx', 'utf8')
  t.check(
    'the Wordmark version tail rides t.textMuted (no fixed FAINT, D11)',
    /version \? <Text color=\{t\.textMuted\}>/.test(assets),
    'source pin',
  )
}

t.finish('prove-wordmark-ramp')
