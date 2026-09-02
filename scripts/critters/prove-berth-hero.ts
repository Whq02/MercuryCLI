#!/usr/bin/env bun
// ============================================================================
//  prove-berth-hero — the cockpit berth carries the AUTHORED hero grid.
//
//  The §MASCOT-DOWNGRADE class: the
//  cockpit sheds the scrollback MercuryHero (the berth owns the always-visible
//  mascot), so when PinnedCritterBerth rendered the 13-wide FLAT art the
//  session's ONLY mascot silently regressed to the earlier "old ugly
//  shape" — and every capture stayed green because nothing pinned the berth's
//  treatment. Three locks, none sufficient alone:
//
//   A. SOURCE — PinnedCritterBerth passes hero= to AnimatedCritterArt and
//      floors on the hero's own named constants (catches a dropped prop).
//   B. ORACLE SOUNDNESS — 'K' pupils exist ONLY in heroArt grids, never in
//      the flat 13-wide art, for every critter (so the render assertion in C
//      actually discriminates hero from flat; if authoring ever changes this,
//      the proof fails loudly here instead of passing vacuously).
//   C. RENDER — a REAL-binary cockpit capture (resume-2turn, 120×44) shows a
//      cell colored with the critter's K-pupil mix in the berth region. In
//      cockpit the berth is the only mascot mount, so K-hue ⇔ hero-in-berth.
//      (String-grep proofs mask broken layout — the render leg is the floor.)
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cellColor,
  CR_COLS,
  CRITTERS,
  decideCritterForm,
  HERO_ART_COLS,
  critterDefForKey,
} from '../../src/utils/cockpit/critterData.js'
import { berthCritterCols, berthCritterForm } from '../../src/components/MercuryHome.js'
import { setSessionCritter } from '../../src/components/mercury-ui/sessionAccent.js'
import { CONFIG_HOME, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const REPO = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')
const norm = (c: unknown): string => String(c ?? '').replace('#', '').toLowerCase()

// ── A. source locks ─────────────────────────────────────────────────────────
{
  const home = read('src/components/MercuryHome.tsx')
  const berth = home.slice(home.indexOf('export function PinnedCritterBerth'))
  const berthBody = berth.slice(0, berth.indexOf('\n}'))
  t('berth passes hero= to AnimatedCritterArt', /AnimatedCritterArt[^/]*hero=\{heroFits\}/.test(berthBody))
  // 3.6.5: the berth decides through the ONE form decision
  // over its ACTUAL allocation — the landing-floor constants no longer gate
  // this surface (the 120×30 flat-critter class). The needle moves WITH the
  // ruling: the gate is decideCritterForm, and hero treatment covers both
  // the hero and premium-compact tiers.
  t('berth floors through the ONE form decision (decideCritterForm over allocated cells)',
    berthBody.includes('decideCritterForm({ columns, rows }') &&
    berthBody.includes("form === 'hero' || form === 'premium-compact'"))
  const layout = read('src/components/FullscreenLayout.tsx')
  t('the statusBand card mounts PinnedCritterBerth', layout.includes('<PinnedCritterBerth />'))
}

// ── A2. B8 equivalence: the exported mirror ≡ the one owner ─────────
//  berthCritterCols/berthCritterForm are the non-hook mirror of the berth's
//  gate. Locks A pin the RENDERER's source to decideCritterForm; these legs
//  pin the MIRROR to the same decision across every floor boundary, for a
//  critter WITH authored hero art and one WITHOUT — so the width budget
//  and the rendered form can never disagree. (RE-CUT, VP-14
//  deletion: the decision is the bare form now — the reason compares died
//  with the plumbing. Row 31 joins the matrix: the hero floor is the
//  DERIVED BERTH_HERO_MIN_ROWS = 28 + the hero-over-flat slot delta, so
//  the boundary sits at 31 with today's authored grids, not the borrowed
//  landing 30.)
{
  const heroCritter = [...CRITTERS].find(c => c.heroArt?.length)
  const flatCritter = [...CRITTERS].find(c => !c.heroArt?.length)
  t('a hero-art critter exists for the matrix', heroCritter !== undefined)
  const matrixCols = [CR_COLS + 1, CR_COLS + 2, HERO_ART_COLS + 3, HERO_ART_COLS + 4, 120]
  const matrixRows = [22, 29, 30, 31, 46]
  const tiers = new Set(['hero', 'premium-compact'])
  if (heroCritter) {
    setSessionCritter(heroCritter.key)
    let drift = ''
    for (const c of matrixCols) {
      for (const r of matrixRows) {
        const owner = decideCritterForm({ columns: c, rows: r }, true)
        const mirror = berthCritterForm(c, r)
        const cols = berthCritterCols(c, r)
        if (mirror !== owner) drift ||= `form@${c}x${r}: ${mirror}≠${owner}`
        if (cols !== (tiers.has(owner) ? HERO_ART_COLS : 13)) drift ||= `cols@${c}x${r}: ${cols}`
      }
    }
    t(`${heroCritter.name}: mirror ≡ owner across the floor matrix (form, width)`, drift === '', drift)
  }
  if (flatCritter) {
    setSessionCritter(flatCritter.key)
    let drift = ''
    for (const c of matrixCols) {
      for (const r of matrixRows) {
        const owner = decideCritterForm({ columns: c, rows: r }, false)
        if (berthCritterForm(c, r) !== owner) drift ||= `form@${c}x${r}`
        if (berthCritterCols(c, r) !== 13) drift ||= `cols@${c}x${r}: ${berthCritterCols(c, r)}`
      }
    }
    t(`${flatCritter.name}: no hero art ⇒ the mirror never grants hero width`, drift === '', drift)
  }
  // A pin must assert EXISTING source: a leg pinning strings that do not
  // exist in FullscreenLayout.tsx, around a `reason` that renders NOWHERE
  // in src/, is asserting a feature into existence — the vacuous-pin class.
  //
  // There is no reason plumbing — the decision is the
  // bare form — and the hero row floor is the DERIVED BERTH_HERO_MIN_ROWS
  // (28 + the hero-over-flat slot delta; math in critterData.ts), replacing
  // the borrowed landing 30 the honesty audit found unbacked by evidence.
  //
  // What this leg locks is the contract the surrounding legs depend on: ONE
  // owner. berthCritterForm delegates to decideCritterForm rather than
  // re-deriving the tiers (and MercuryHome never references the floor
  // constants), so the width budget, any future hover hint, and the rendered
  // form cannot drift apart.
  const home = read('src/components/MercuryHome.tsx')
  t('berthCritterForm delegates to decideCritterForm (VP-01/02: ONE owner, never a re-derivation)',
    /export function berthCritterForm[\s\S]{0,400}?return decideCritterForm\(/.test(home) &&
    !/PREMIUM_COMPACT_MIN_ROWS|BERTH_HERO_MIN_ROWS|rows >= 30/.test(home))
  t('the berth RENDERER takes the same decision, not a private gate',
    /const form = decideCritterForm\(/.test(home))
  // Restore the render leg's pinned critter (env pins crab below anyway).
  setSessionCritter('crab')
}

// ── B. oracle soundness: K is a hero-grid-only letter ───────────────────────
// The POOL only: this oracle asks whether a K on screen
// proves the HERO grid rendered, which needs every candidate's FLAT grid to be
// K-free. The Concourse resident authors a K in its flat art (its eye is an E/K
// cluster at the stalk tip) and the berth never renders it, so including it
// would break the oracle's soundness rather than test it.
const ALL = [...CRITTERS]
for (const def of ALL) {
  t(`${def.name}: flat art carries NO 'K' (oracle stays sound)`, !def.art.some(r => r.includes('K')))
  if (def.heroArt?.length) {
    t(`${def.name}: heroArt carries 'K' pupils`, def.heroArt.some(r => r.includes('K')))
  }
}

// ── C. rendered evidence through the REAL binary ────────────────────────────
type GridCell = { c: string; fg: string; bg: string }
type Grid = { grid: GridCell[][] }

function capture(tag: string): Grid {
  const cfg = scenario('resume-2turn', 120, 44)
  const out = `/tmp/berth-hero-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/berth-hero-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends: [], total: 55, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '..', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      // Deterministic shape: pin the session critter; gaze stays scenario-
      // pinned OFF (rest pose), idle blink can land a lid → retry below.
      MERCURY_CRITTER: 'crab',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  return JSON.parse(readFileSync(out, 'utf8')) as Grid
}

// The berth def re-tints with the session accent; for the pinned crab the hue
// IS the crab def's hue, so the production mapping gives the exact pupil mix.
const PUPIL_HEX = norm(cellColor(critterDefForKey('crab'), 'K'))

function pupilCellsInBerthRegion(g: Grid): number {
  let hits = 0
  const rows = Math.min(14, g.grid.length) // the berth card sits under the center header
  for (let y = 0; y < rows; y++) {
    for (const cell of g.grid[y]!) {
      if (norm(cell.bg) === PUPIL_HEX || norm(cell.fg) === PUPIL_HEX) hits++
    }
  }
  return hits
}

{
  let hits = pupilCellsInBerthRegion(capture('a'))
  if (hits === 0) {
    // ~4% odds the capture landed on a blink lid (heroBlinkRows swaps the
    // K pupil for the lid shade). One retry; two coincident lids ≈ 0.2%.
    hits = pupilCellsInBerthRegion(capture('b'))
  }
  t('cockpit berth renders the HERO grid (K-pupil mix on screen, top region)', hits > 0, `pupil cells=${hits}`)
}

console.log(failures === 0 ? '✅ berth-hero contract holds' : '❌ berth-hero contract BROKEN')
process.exit(failures)
