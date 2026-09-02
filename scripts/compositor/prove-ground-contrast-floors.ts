#!/usr/bin/env bun

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
