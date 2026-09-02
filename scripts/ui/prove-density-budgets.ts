#!/usr/bin/env bun
// scripts/ui/prove-density-budgets.ts — the §6 visual-hierarchy budgets
// Pure — reads the COMMITTED baseline grids, so "more borders,
// more chips, more accent" can never masquerade as polish: a change that
// densifies the chrome past the ratified ceilings fails here with numbers.
//
// The ceilings are the MEASURED baseline (the density
// baseline) plus a small headroom — they ratchet DOWN as polish lands, never
// silently up. Laws enforced per §6:
//   L1 border cells ≤ ceiling per entry (the box-soup metric);
//   L2 accent cells ≤ ceiling per entry (accent stays scarce — identity,
//      focus, current work; the hero/wordmark art rides inside the ceiling);
//   L3 vertical-border ROW DENSITY: rows with ≥6 │ cells are ratcheted at
//      the measured baseline (13 on the ≥150-col tiers — rail panels BESIDE
//      the center panel WITH its interior card: siblings plus depth-2
//      nesting). NOTE (S12a correction): this measures row density, NOT
//      containment depth — true nesting at the wide tier is 2 (center →
//      berth/hero card), WITHIN the §6 law. The ratchet still forbids any
//      new vertical chrome; a real depth-3 would push these counts up and
//      fail here;
//   L4 bold stays scarce (≤ ceiling — weight is hierarchy, not decoration).
import { readManifest, readStoredGrid } from './visualBaseline.ts'

const BORDER = new Set('╭╮╰╯│─┈┃━║═▔▁'.split(''))

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// Ceilings per entry id — measured baseline + ~10% headroom, rounded up.
// A new capture class inherits DEFAULTS scaled by viewport area.
// Bold ceilings re-recorded across 18 entries (run-4 re-ratify): two landed
// estates the pre-rail ratification never saw now paint bold by design —
// the lanes rail's SECTION HEADERS (SEAT · RECENT · MINERVA · WORKBENCH ·
// NEXT · TELEMETRY · SESSIONS) and the attention strip's bold session
// title, whose length scales with the tier width (11 cells at 80 cols,
// ~50 at 120). The recaptured baselines record the live product; each
// ceiling is that entry's measured bold + ~10% headroom. Weight still
// reads as hierarchy: headers and the one working-session identity line,
// never body decoration — a NEW bold estate must re-ratify here again.
const CEILINGS: Record<string, { borderPct: number; accent: number; bold: number; deepRows?: number }> = {
  'frame--60x18--dark--truecolor--full': { borderPct: 24, accent: 300, bold: 20 },
  'frame--80x24--dark--truecolor--full': { borderPct: 24, accent: 390, bold: 33 },
  'frame--97x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  // the breakpoint NEIGHBORS joined the baseline (99/101 beside
  // the 100-col gate, 151 beside 150) — each pinned to its TIER's ratified
  // ceilings, because the whole point of a neighbor is rendering the same
  // deliberate composition as the threshold it flanks.
  'frame--99x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'frame--100x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'frame--101x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'frame--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 77 },
  'frame--149x40--dark--truecolor--full': { borderPct: 27, accent: 640, bold: 75, deepRows: 13 },
  // 150-col ceilings re-recorded: the
  // doctor-cert HEALTH card no longer pads the wide rail with content (the
  // capture env pins MERCURY_DOCTOR_STATE_DIR at scratch), so the emptier
  // bordered cards carry a point more border share. Deliberate, measured.
  // deepRows 13→15 re-recorded:
  // the berth card now fills the true center-inner width, so its border
  // rows align with two more rail-card border rows at the both-rails tier.
  // Same chrome, same depth-2 nesting — row ALIGNMENT, not new verticals
  // (render-verified at 150x40; the ratchet stays exact at the new measure).
  'frame--150x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'frame--151x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'frame--160x50--dark--truecolor--full': { borderPct: 27, accent: 720, bold: 102, deepRows: 15 },
  'cockpit-wide--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 120 },
  'resume-2turn--60x18--dark--truecolor--full': { borderPct: 24, accent: 300, bold: 20 },
  'resume-2turn--80x24--dark--truecolor--full': { borderPct: 24, accent: 390, bold: 33 },
  'resume-2turn--97x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'resume-2turn--99x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'resume-2turn--100x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'resume-2turn--101x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'resume-2turn--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 77 },
  'resume-2turn--149x40--dark--truecolor--full': { borderPct: 27, accent: 640, bold: 75, deepRows: 13 },
  'resume-2turn--150x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 }, // hermetic re-record + deepRows (see frame--150x40 notes)
  'resume-2turn--151x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'resume-2turn--160x50--dark--truecolor--full': { borderPct: 27, accent: 720, bold: 102, deepRows: 15 },
  // LUSTRE L1: the layered claim — the session-manager surface
  // bottom-anchors and the RECESSED cockpit stays visible above it, so the
  // frame legitimately carries BOTH layers' borders/bold (backdrop rails +
  // center panel + the surface's own cards). Re-measured on the committed
  // baseline: border 22% · bold 51. Deliberate, measured — the recess keeps
  // the extra structure QUIET (every backdrop cell is the 50% canvas fold).
  // bold 55→65: the redesigned octopus mascot carries bold
  // eye/highlight cells (+7 measured on the regenerated baseline) — the
  // operator-directed art footprint, not a chrome density change.
  'sessions--120x40--dark--truecolor--full': { borderPct: 24, accent: 440, bold: 103 },
  'tool-cards--120x40--dark--truecolor--full': { borderPct: 24, accent: 545, bold: 110 },
  'help--120x40--dark--truecolor--full': { borderPct: 24, accent: 545, bold: 60 },
}
const DEFAULT_PER_CELL = { borderPct: 30, accentPerKcell: 200, boldPerKcell: 30 }

const manifest = readManifest()
if (!manifest) {
  console.log('FAIL  manifest present')
  process.exit(1)
}

for (const e of manifest.entries) {
  // Budgets are ratified on the DARK truecolor estate (the identity look);
  // other families share geometry, so dark coverage bounds the shape.
  if (e.theme !== 'dark' || e.colorMode !== 'truecolor' || e.motion !== 'full') continue
  const grid = readStoredGrid(e)
  const total = e.cols * e.rows
  let border = 0
  for (const row of grid.text) for (const ch of row) if (BORDER.has(ch)) border++
  let accent = 0
  let bold = 0
  let deepRows = 0
  for (let y = 0; y < grid.rows; y++) {
    for (const sp of grid.styles[y]) {
      if (sp[2] === 'dd4444') accent += sp[1]
      if (sp[4] & 1) bold += sp[1]
    }
    const bars = (grid.text[y].match(/│/g) ?? []).length
    if (bars >= 6) deepRows++
  }
  const borderPct = Math.round((100 * border) / total)
  const c = CEILINGS[e.id] ?? {
    borderPct: DEFAULT_PER_CELL.borderPct,
    accent: Math.ceil((total / 1000) * DEFAULT_PER_CELL.accentPerKcell),
    bold: Math.ceil((total / 1000) * DEFAULT_PER_CELL.boldPerKcell),
  }
  t(`${e.id}: border ${borderPct}% ≤ ${c.borderPct}%`, borderPct <= c.borderPct)
  t(`${e.id}: accent ${accent} ≤ ${c.accent}`, accent <= c.accent)
  t(`${e.id}: bold ${bold} ≤ ${c.bold}`, bold <= c.bold)
  const deepCeil = c.deepRows ?? 0
  t(`${e.id}: ≥6-│ row density ${deepRows} ≤ ${deepCeil}`, deepRows <= deepCeil)
}

if (fail) {
  console.log('\n❌ density budgets — a ceiling broke (numbers above)')
  process.exit(1)
}
console.log('\n✅ density budgets — border/accent/bold/nesting inside the ratified ceilings')
