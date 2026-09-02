#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-finish/prove-qual-matrix.ts — the RF-17 theme/effective-accent
//  matrix at the resolver+sampler level: all eight families, one law.
//
//    ELIGIBLE (dark × any parseable accent — crab, fable, non-crab warm,
//    non-crab cool): the family derives a 3-stop ramp of its OWN hue and the
//    42-cell walk is CONTINUOUS (more than the stop count of distinct
//    colours) and per-channel monotone.
//
//    REDUCED (light, dark-ansi, both daltonized): the ramp collapses to ONE
//    stop and every focal surface's walk is FLAT-IDENTICAL — the small
//    wordmark, the banner rows, and a solid span all paint the SAME single
//    segment colour (equivalent surfaces agree).
//
//    NO_COLOR: the app strips at the colorize authority (shouldHonorNoColor
//    truth pinned here; the zero-SGR render legs live in prove-splash.py and
//    the 'none' colorMode manifest entries).
//
//  The RENDER-level matrix evidence: the visual manifest's 48 entries span
//  dark/light/ansi/daltonized × truecolor/256/ansi/none on real captures;
//  the fable/critter AFTER captures pin the derived-ramp families
//  (the capture dir).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { bigWordmarkRows } from '../../src/components/mercury-ui/assets.tsx'
import { rampSegments, type RampSegment } from '../../src/components/mercury-ui/focalRamp.ts'
import { TERRA } from '../../src/components/mercuryPalette.ts'

/** A second warm-red accent sample (the retired storm-register hue). */
const WARM_RED_SAMPLE = '#DE4A35'
import { resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { shouldHonorNoColor } from '../../src/ink/colorize.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const parse = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const cells = (segs: RampSegment[]): string[] => segs.flatMap(s => [...s.text].map(() => s.color))

t.section('eligible families derive + walk continuously')
{
  const accents: Array<[string, string]> = [
    ['dark crab', TERRA],
    ['dark warm-red', WARM_RED_SAMPLE],
    ['dark non-crab warm', '#FF5A3A'],
    ['dark non-crab cool', '#7755EE'],
  ]
  for (const [label, accent] of accents) {
    const tok = resolveMercuryTokens('dark', accent)
    t.check(
      `${label}: derives a 3-stop ramp of its OWN hue`,
      tok.focalRamp.length === 3 && tok.focalRamp[0] === accent && tok.focalRamp[1] === tok.accentSoft,
      tok.focalRamp.join(' '),
    )
    const walk = cells(rampSegments('M'.repeat(42), tok.focalRamp))
    t.check(
      `${label}: the 42-cell walk is continuous (> 3 distinct colours)`,
      new Set(walk).size > 3,
      `${new Set(walk).size} distinct`,
    )
    const first = parse(walk[0] ?? '')
    const last = parse(walk[walk.length - 1] ?? '')
    let monotone = true
    for (let c = 0; c < 3 && monotone; c++) {
      const dir = Math.sign((last[c] ?? 0) - (first[c] ?? 0))
      for (let i = 1; i < walk.length; i++) {
        const step = (parse(walk[i] ?? '')[c] ?? 0) - (parse(walk[i - 1] ?? '')[c] ?? 0)
        if (dir !== 0 && Math.sign(step) !== 0 && Math.sign(step) !== dir) {
          monotone = false
          break
        }
      }
    }
    t.check(`${label}: per-channel monotone`, monotone, 'walk')
  }
}

t.section('reduced families collapse flat-identical across equivalent surfaces')
{
  for (const family of ['light', 'dark-ansi', 'dark-daltonized', 'light-daltonized'] as const) {
    const tok = resolveMercuryTokens(family, TERRA)
    t.check(`${family}: one-stop ramp`, tok.focalRamp.length === 1, tok.focalRamp.join(' '))
    const word = rampSegments('Mercury', tok.focalRamp)
    const banner = bigWordmarkRows().map(r => rampSegments(r, tok.focalRamp))
    const solid = rampSegments('M'.repeat(42), tok.focalRamp)
    const flatColor = word[0]?.color
    t.check(
      `${family}: wordmark, banner rows and a solid span ALL paint one identical flat segment`,
      word.length === 1 &&
        solid.length === 1 &&
        solid[0]?.color === flatColor &&
        banner.every(rows => rows.length === 1 && rows[0]?.color === flatColor),
      `${flatColor}`,
    )
  }
}

t.section('NO_COLOR strips at the one authority')
{
  t.check(
    'NO_COLOR=1 (no FORCE_COLOR) honors',
    shouldHonorNoColor({ NO_COLOR: '1' }) === true,
    'truth',
  )
  t.check(
    'FORCE_COLOR overrides (spec precedence)',
    shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '1' }) === false,
    'truth',
  )
  t.check(
    'empty NO_COLOR is unset per the spec',
    shouldHonorNoColor({ NO_COLOR: '' }) === false,
    'truth',
  )
}

t.finish('prove-qual-matrix')
