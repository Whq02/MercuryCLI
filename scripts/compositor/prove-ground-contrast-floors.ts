#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-ground-contrast-floors.ts — the painted-ground
//  pair-scan (phase-2 a11y-p2-01/02/09/11, re-anchored for the
//  ROUND-7 FLAT GROUND).
//
//  Round 7 retired the graded spectral field: the ONE painted ground is the
//  flat estate NIGHT (t.canvas). Every essential ink must clear its floor
//  against THAT actual ground. (The text-grade token derivations still
//  floor against the historical spectraGround.bottom sample — a strictly
//  LIGHTER ground than NIGHT — so the derived inks carry conservative
//  headroom by construction; this scan pins the truth on the painted
//  ground.)
//
//    §1  TEXT floors — the derived text-grade roles (textInstruction,
//        infoText, failureText) and textSecondary clear ≥4.5 on the flat
//        ground; textMuted (the documented decoration class) clears the
//        ≥3.0 graphical floor. The class split is the token contract:
//        instruction-class runs NEVER paint raw FAINT/OASIS/CRIMSON.
//    §2  FOCUSED-PILL ink — the focused pill's ink is textInverse on the
//        accentSoft pill and clears ≥4.5 for EVERY catalogued critter
//        accent (t.info-on-pill measured 1.72–2.82 — the a11y-p2-09 class).
//        The live pill sites are the status-rail model + project segments.
//    §3  BANDED-CURSOR guard (a11y-p2-11 forward guard) — the ONE banded
//        cursor site today is the needs-you rail; the derived selectionBand
//        must stay visibly distinct from the flat ground it sits on.
//    §4  THE TRUECOLOR GATE (a11y-p2-03) + collapsed-focus ink (a11y-p2-04)
//        — source ratchets: the estate ground gates on truecolorActive()
//        (reduced depth stays honest), and every collapsed-palette focused
//        pane fork carries the visible info ink, never borderSubtle (ansi
//        BLACK at level 1). The switchboard shell superseded the board/peek shell:
//        the bordered focusable panes are the sessions LIST, the
//        COORDINATOR pane, and the composer STRIP.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const { resolveMercuryTokens, contrastRatio } = await import(
  '../../src/utils/mercuryTokens.ts'
)
const { TERRA } = await import('../../src/components/mercuryPalette.ts')
const { OCTOPUS_HUE, JELLYFISH_HUE, CLAM_HUE, EMBER_HUE } = await import(
  '../../src/utils/cockpit/critterData.ts'
)

const ACCENTS: Array<[string, string]> = [
  ['crab', TERRA],
  ['octopus', OCTOPUS_HUE],
  ['jellyfish', JELLYFISH_HUE],
  ['clam', CLAM_HUE],
  ['furnace-ember', EMBER_HUE],
]

const dark = resolveMercuryTokens('dark', TERRA)
if (dark.canvas === undefined) throw new Error('dark family lost its canvas ground')
// Round 7: the ONE painted ground — the flat estate NIGHT canvas.
const FIELD = dark.canvas

function worstOnField(ink: string): { ratio: number; at: string } {
  const r = contrastRatio(ink, FIELD)
  return { ratio: r ?? 0, at: `flat ${FIELD}` }
}

t.section('§1 — text floors on the ACTUAL painted ground (the flat estate NIGHT)')
{
  const essential: Array<[string, string]> = [
    ['textInstruction (help legend · hints · chip labels · AGE · headers)', dark.textInstruction],
    ['infoText (pane titles · status mark · coordinator segment)', dark.infoText],
    ['failureText (refusal words)', dark.failureText],
    ['textSecondary', dark.textSecondary],
    ['textPrimary', dark.textPrimary],
  ]
  for (const [name, ink] of essential) {
    const w = worstOnField(ink)
    t.check(`${name} ≥ 4.5 on every field row`, w.ratio >= 4.5, `${ink} worst ${w.ratio.toFixed(2)} @ ${w.at}`)
  }
  const muted = worstOnField(dark.textMuted)
  t.check(
    'textMuted (documented DECORATION class: separators, ellipses) ≥ 3.0',
    muted.ratio >= 3.0,
    `${dark.textMuted} worst ${muted.ratio.toFixed(2)} @ ${muted.at}`,
  )
  // The derivation stays QUIET: the instruction ink must not jump past
  // textSecondary's own weight (the muted hierarchy survives the floor).
  const instrVsSecondary = contrastRatio(dark.textInstruction, dark.spectraGround!.bottom)
  const secondary = contrastRatio(dark.textSecondary, dark.spectraGround!.bottom)
  t.check(
    'textInstruction stays quieter than textSecondary (hierarchy preserved)',
    instrVsSecondary !== null && secondary !== null && instrVsSecondary < secondary,
    `instruction ${instrVsSecondary?.toFixed(2)} < secondary ${secondary?.toFixed(2)}`,
  )
}

t.section('§2 — the focused pill: textInverse on the accentSoft pill, every accent')
{
  for (const [name, hue] of ACCENTS) {
    const tokens = resolveMercuryTokens('dark', hue)
    const r = contrastRatio(tokens.textInverse, tokens.accentSoft)
    t.check(
      `${name}: focused-chip ink on pill ≥ 4.5`,
      r !== null && r >= 4.5,
      `${tokens.textInverse} on ${tokens.accentSoft} = ${r?.toFixed(2) ?? 'null'}`,
    )
  }
}

t.section('§3 — banded-cursor guard: the band stays visible on the flat ground')
{
  // Round 7: the rail sits on the ONE flat ground everywhere — the floor is
  // the derivation's plateau value (measured 1.15–1.18 across the accent
  // catalogue against NIGHT); a derivation change that sinks the band into
  // the ground reds here before it ships.
  const BAND_FLOOR = 1.1
  for (const [name, hue] of ACCENTS) {
    const tokens = resolveMercuryTokens('dark', hue)
    const r = contrastRatio(tokens.selectionBand, FIELD)
    t.check(
      `${name}: selectionBand vs the flat ground ≥ ${BAND_FLOOR}`,
      r !== null && r >= BAND_FLOOR,
      `${tokens.selectionBand} ${r?.toFixed(3) ?? 'null'} vs ${FIELD}`,
    )
  }
}

t.section('§4 — the truecolor gate + collapsed-focus ink (source ratchets)')
{
  const layout = readFileSync('src/components/concourse/ConcourseLayout.tsx', 'utf8')
  const tokensSrc = readFileSync('src/utils/mercuryTokens.ts', 'utf8')
  t.check(
    'the estate ground gates on truecolorActive() (a11y-p2-03: reduced depth stays honest)',
    /export function estateGroundBg[\s\S]{0,220}truecolorActive\(\)/.test(tokensSrc),
    'estateGroundBg carries the depth gate',
  )
  const colorize = readFileSync('src/ink/colorize.ts', 'utf8')
  t.check(
    'colorize owns the ONE depth predicate (truecolorActive = level ≥ 3)',
    colorize.includes('export function truecolorActive') && colorize.includes('chalk.level >= 3'),
    'the chalk-authority module',
  )
  // The
  // bordered focusable panes are the sessions LIST (ConcourseLayout),
  // the COORDINATOR pane, and the composer STRIP — each keeps the
  // collapsed-palette info fork.
  // The list and coordinator panes moved PAST the collapsed-only fork: the
  // FOCUSED pane wears the visible info ink at every depth (borderSubtle
  // only ever paints unfocused), which satisfies a11y-p2-04 a fortiori —
  // the collapsed palette keeps its bold SHAPE fork beside it. The strip
  // keeps the collapsed-conditional ink fork (its resting ink is a prop).
  const listFork = /borderColor=\{region === 'list' \? t\.info : t\.borderSubtle\}/.test(layout)
  const coordPane = readFileSync('src/components/concourse/CoordinatorPane.tsx', 'utf8')
  const coordFork = /borderColor=\{focused \? t\.info : t\.borderSubtle\}/.test(coordPane)
  const strips = readFileSync('src/components/concourse/ConcourseStrips.tsx', 'utf8')
  const stripFork = /borderColor=\{paletteCollapsed\(\) && focused \? t\.info : borderColor\}/.test(strips)
  t.check(
    'collapsed-palette FOCUSED pane forks wear the visible info ink (a11y-p2-04)',
    listFork && coordFork && stripFork,
    `list ${listFork} · coordinator ${coordFork} · strip ${stripFork} (borderSubtle quantizes to ansi BLACK at level 1)`,
  )
  // The pill and its ink ride the SAME open flag at both status-rail
  // segments — the pill never paints under any other ink.
  t.check(
    'the focused chip ink is textInverse on the pill (a11y-p2-09)',
    strips.includes('modelPickerOpen ? t.textInverse') &&
      strips.includes('modelPickerOpen ? { backgroundColor: t.accentSoft }') &&
      strips.includes('groundPickerOpen ? t.textInverse') &&
      strips.includes('groundPickerOpen ? { backgroundColor: t.accentSoft }'),
    'never t.info on accentSoft (the status-rail model + project pills)',
  )
}

t.finish('prove-ground-contrast-floors')
