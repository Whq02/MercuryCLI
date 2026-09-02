#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-helm-home.ts — render-verify for the A2.2 Helm cockpit home
//  (FullscreenLayout's HELM_HOME branch). Drives the resume-2turn fullscreen
//  session in a pyte PTY (via render-tui's vshot pipeline) under three configs
//  and asserts the structural markers a broken layout would lose:
//
//    cockpit @120 (MERCURY_HELM_HOME=1) : the lanes render (SEAT/CREW
//                  + usage/trace/substrate), AND the welcome's duplicate
//                  "fleet … · trace … · substrate" glance line is SHED (dedup).
//    degrade @80  (MERCURY_HELM_HOME=1) : rails auto-hidden — the deck strip + the
//                  welcome fleet-glance line are PRESENT (byte-identical to today).
//    off     @120 (no flag)            : today's deck-strip home (no lane headers).
//
//  Verify-by-RENDERING: captures real PNGs + greps the cell grid.
//  Run:  ~/.bun/bin/bun run scripts/ui/render-helm-home.ts
//  Out:  /tmp/helm-home-{cockpit-120,degrade-80,off-120}.png  + a PASS/FAIL summary.
// ============================================================================
import { writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const NAME = 'resume-2turn'
const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

// Capture one config → cell grid (with the blank-guard + one retry, like render-tui).
function capture(cols: number, helm: boolean, scenarioName: string = NAME): Grid {
  const tag = scenarioName === NAME ? `${cols}-${helm ? 'on' : 'off'}` : `${scenarioName}-${cols}`
  const gridPath = `/tmp/helm-home-grid-${tag}.json`
  const cfg = { ...scenario(scenarioName, cols, 44), out: gridPath }
  const cfgPath = `/tmp/vshot-helm-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  // MERCURY_HELM_HOME is default-ON, so the "off" case must EXPLICITLY opt out
  // with =0 (not merely unset — unset = the cockpit). =1 is redundant with the
  // default but kept explicit so the test states its intent.
  const env: NodeJS.ProcessEnv = { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME }
  env.MERCURY_HELM_HOME = helm ? '1' : '0'
  const painted = (g: Grid) => g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(30000), env })
    if (res.status !== 0) continue
    grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
    if (painted(grid) >= 40) break
  }
  return grid
}

const text = (g: Grid) => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

let failures = 0
function expect(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' Helm cockpit home render-verify (vshot, 80 & 120)')
console.log('============================================================')

// --- cockpit @120 ---------------------------------------------------------
console.log('\n▶ cockpit @120 (MERCURY_HELM_HOME=1)')
const c120 = capture(120, true)
const t120 = text(c120)
gridToPng(`/tmp/helm-home-grid-120-on.json`, '/tmp/helm-home-cockpit-120.png').then(r => console.log('  png:', r.path))
// CENTER-FIRST recalibration: @120 is the SINGLE-RAIL tier —
// the solo lanes rail (SEAT + RECENT/NEXT glanceables, the
// uniqueness-program layout; CREW is the BUSY branch) + the merged
// TELEMETRY glance. The full telemetry rail's needles moved to @150 below,
// where the ratified plan mounts it.
expect('SEAT lane header present', /SEAT/.test(t120))
expect('solo RECENT glanceable present', /RECENT/.test(t120))
expect('solo NEXT hints present', /NEXT/.test(t120))
expect('merged TELEMETRY glance present (folded rail leaves the glance)', /TELEMETRY/.test(t120))
expect('glance usage row (5h N%)', /5h \d+%/.test(t120))
expect('glance ctx row (`ctx … · <N>k`)', /ctx .{0,8}· \d+k/.test(t120))
expect('NO full telemetry-rail headers at the folded tier', !/substrate · \d/.test(t120))
// Dedup: the welcome's combined "fleet … · trace … · substrate …" glance line is
// SHED when the cockpit owns those datums.
expect('welcome fleet-glance line SHED (no "no fleet · trace" dup)', !/no fleet · trace/.test(t120))

// --- both-rails @150 (the ratified 'very wide' tier) -----------------------
console.log('\n▶ both rails @150 (center-first: telemetry rail returns)')
const c150 = capture(150, true)
const t150 = text(c150)
// Case-insensitive: the cockpit-panel pass renders wide-tier rail
// sections as RailPanel cards with UPPERCASE headers (▆ USAGE / ◔ TRACE /
// ⊡ SUBSTRATE); below 150 the flat SectionHeader stays lowercase. The probe's
// meaning is "the telemetry sections RETURN at 150", not their case treatment.
expect('@150: usage telemetry header present', /usage/i.test(t150))
expect('@150: trace telemetry header present', /trace/i.test(t150))
expect('@150: substrate telemetry header present', /substrate/i.test(t150))
expect('@150: ctx-fill gauge present (telemetry rail)', /ctx .{0,8}· \d+k/.test(t150))
expect('@150: SEAT lane still present (both rails)', /SEAT/.test(t150))

// --- degrade @80 ----------------------------------------------------------
console.log('\n▶ degrade @80 (MERCURY_HELM_HOME=1 — rails auto-hidden)')
const d80 = capture(80, true)
const t80 = text(d80)
gridToPng(`/tmp/helm-home-grid-80-on.json`, '/tmp/helm-home-degrade-80.png').then(r => console.log('  png:', r.path))
// Rails gone (no lane headers), AND today's deck-strip home is intact: the deck
// vitals row + the welcome fleet-glance line are BOTH present (nothing lost).
expect('no SEAT lane header at narrow (rails hidden)', !/SEAT ·/.test(t80))
expect('deck strip present at narrow (ops rail: daemon ○ · fleet ○ · trace N)', /daemon [○●]/.test(t80))
expect('vitals KEPT at narrow (deck 5h gauge — no data loss)', /5h [█░]/.test(t80))

// --- off @120 -------------------------------------------------------------
console.log('\n▶ opt-out @120 (MERCURY_HELM_HOME=0 — today\'s deck-strip home)')
const o120 = capture(120, false)
const to120 = text(o120)
gridToPng(`/tmp/helm-home-grid-120-off.json`, '/tmp/helm-home-off-120.png').then(r => console.log('  png:', r.path))
expect('no cockpit lane headers when flag off', !/SEAT ·/.test(to120))
expect('deck strip present when flag off (ops rail)', /daemon [○●]/.test(to120))

cleanupScenario(NAME)

// --- cockpit-wide @120: the transcript must WRAP IN-COLUMN, not bleed under the
//     right rail. The overlap bug spliced rail glyphs INTO the prose ("ju○ Capab…"),
//     so a long phrase staying contiguous is the regression guard. (Short messages
//     never wrapped wide enough to expose this — it shipped to default once.) ------
console.log('\n▶ cockpit-wide @120 (long prose — transcript must stay in its column)')
const w120 = capture(120, true, 'cockpit-wide')
const tw = text(w120)
gridToPng('/tmp/helm-home-grid-cockpit-wide-120.json', '/tmp/helm-home-wide-120.png').then(r => console.log('  png:', r.path))
// Center-first @120 wraps the fixture at a new position ('indifferent' now
// ends a row) — assert the phrase ACROSS the break, and the overlap guard by
// its real meaning: no rail glyph spliced INTO prose (the bug looked like
// 'ju○ Capab…' — a letter immediately followed by a rail glyph).
// CENTER-COLUMN join: the whole-grid join put the LEFT RAIL's
// cells between the wrap halves, so the needle only matched when the rail
// happened to be blank beside the wrap point — the teams-hermetic seam made
// the solo rail (RECENT/NEXT/TELEMETRY) render there and broke the accident.
// Slice each row past the rail before joining: the phrase test now reads the
// column the prose actually lives in, rail state irrelevant.
const RAIL_W = 24
const twCenter = w120.grid.map(r => r.map(c => c.c || ' ').join('').slice(RAIL_W)).join('\n')
// The wrap break may cross the CENTER PANEL's border cells (the
// bordered transcript panel puts `│` at each row edge) — allow them between
// the halves. A rail-glyph splice still fails the letter+glyph needle below.
expect('long prose wrapped (phrase survives across the break)', /indifferent[\s│]+sea/.test(twCenter))
expect('prose NOT broken by a rail glyph (no letter+glyph splice)', !/[a-z][○●◐⚠]/.test(tw))
expect('the fleet-glance dup stays SHED with the cockpit-active context', !/no fleet · trace/.test(tw))

console.log('\n============================================================')
if (failures === 0) console.log('✅ HELM-HOME RENDER PASS')
else console.log(`❌ HELM-HOME RENDER: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
