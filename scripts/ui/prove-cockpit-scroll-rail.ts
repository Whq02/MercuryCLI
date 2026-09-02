#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-cockpit-scroll-rail.ts
//  PROOF: scrolling the cockpit transcript never drags the side rails
//
//
//  Mechanism it guards: Screen.shift()/DECSTBM move ENTIRE rows; a ScrollBox
//  that doesn't span the full output width (the helm center pane between the
//  rails) must NOT take the blit+shift fast path, or its siblings' cells ride
//  the scroll delta (the left rail paints before the shift and got dragged;
//  live repro: SEAT's body vanished at scroll-top). The guard lives in
//  src/ink/compose-walk.ts (spansFullWidth).
//
//  The leg drives the REAL binary in a PTY: a tall session in the 150-col
//  cockpit, PageUp'd to the top, then asserts the SCROLLED state is actually
//  on screen (hero + jump-to-bottom pill) AND both rails are intact.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-cockpit-scroll-rail.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bigWordmarkRows } from '../../src/components/mercury-ui/assets.js'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' cockpit scroll — rails stay pinned (rail-drag regression)')
console.log('============================================================')

const cfg = scenario('cockpit-scrolled', 150, 40)

// RECENT needs a NON-CURRENT session for this project — the operator's real
// home always had some; a fresh home (CI) has only the staged current one,
// so the RECENT section legitimately rendered empty (the F6 ambient class).
// Stage one minimal extra session, prover-local (renderScenarios itself must
// not grow rows — the visual baselines were captured without one).
const RECENT_SID = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
const { sanitizePath: sanitizeRail } = await import('../../src/utils/sessionStoragePortable.ts')
const RAIL_PROJECTS = join(CONFIG_HOME, 'projects', sanitizeRail(join(import.meta.dir, '..', '..')))
mkdirSync(RAIL_PROJECTS, { recursive: true })
const recentPath = join(RAIL_PROJECTS, `${RECENT_SID}.jsonl`)
if (!existsSync(recentPath)) {
  writeFileSync(
    recentPath,
    [
      JSON.stringify({ type: 'user', uuid: `${RECENT_SID}-u1`, sessionId: RECENT_SID, timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { role: 'user', content: 'recent fixture session' } }),
      JSON.stringify({ type: 'assistant', uuid: `${RECENT_SID}-a1`, parentUuid: `${RECENT_SID}-u1`, sessionId: RECENT_SID, timestamp: new Date(Date.now() - 3_599_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok.' }] } }),
    ].join('\n') + '\n',
  )
}

const gridPath = `/tmp/cockpit-scroll-rail-grid-${process.pid}.json`
const cfgPath = `/tmp/cockpit-scroll-rail-cfg-${process.pid}.json`
writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))

const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf8',
  timeout: vshotBudgetMs(90_000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    // PINNED seat name: the seat row is
    // `● <name> (you)` and RailRow truncates the name to a width budget —
    // the calibration machine's short login fit where CI's 'runner' fell to
    // 'runner (y…', so the shape regex below missed a row that WAS there.
    // getOperatorName() honors the operator flag first; a short neutral pin
    // renders identically on every machine. CANONICAL spelling: the
    // renderScenarios pin block inherits MERCURY_OPERATOR='sam' into every
    // scenario env — only the same key overrides it.
    MERCURY_OPERATOR: 'op',
    // PINNED presence room (the prove-hover-e2e idiom): the default room
    // is CWD-derived and shared through the real home, so a co-tenant
    // capture's heartbeat lands as an async PEER row that displaces the
    // anchored rail sections (seen live: a concurrent pool's operator beat
    // starved RECENT/NEXT). A unique room keeps the SEAT section single-row.
    MERCURY_CHANNEL_ROOM: `scroll-rail-${process.pid}`,
  },
})
check('PTY capture ran', res.status === 0, res.stderr?.slice(0, 200) ?? '')

if (res.status === 0) {
  const grid = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
  }
  const lines = grid.grid.map(r => r.map(c => c.c).join(''))
  const rowOf = (needle: string): number => lines.findIndex(l => l.includes(needle))

  // The capture must really be SCROLLED AWAY at the transcript top — without
  // this, a broken scroll would vacuously "keep" the rails. BOTH sticky
  // descriptors prove it: '[ back to the bottom · alt+↓ ]' (nothing new since
  // scrolling) and '[ N new message(s) · alt+↓ ]' (a late boot append landed
  // while scrolled — CI's slower boot hits this legitimately).
  check(
    'scrolled state on screen (jump-to-bottom pill up)',
    rowOf('back to the bottom') > 0 || lines.some(l => / \d+ new message/.test(l)),
  )
  check('transcript top reached (turn 1 visible)', rowOf('turn 1: say something long') > 0)
  // Single-brand pass: at cockpit geometry the turns-state
  // furniture is the block MERCURY banner-header — pin its exact first
  // letterform row (the pure bigWordmarkRows primitive), with the compact
  // `Mercury` literal accepted as the narrow-fallback form.
  const bannerRow = bigWordmarkRows()[0]!.trimEnd()
  check(
    'banner-header revealed at top',
    rowOf(bannerRow) >= 0 || rowOf('Mercury') >= 0,
  )

  // The left lanes rail: header AND body intact at their pinned rows. Since
  // the panel pass the sections wear RailPanel cards; since the
  // interaction-finish slice-3 stable-geometry pass the lanes rail RESERVES
  // its focus-banner row permanently (row 0 — ' lanes' unfocused), so the
  // SEAT panel's top border is row 1 and its header row 2.
  const seatRow = rowOf('SEAT')
  // The seat body row is matched by SHAPE — the login name is machine truth
  // (the baked fixture handle could not exist on CI, and userInfo() under a scrubbed
  // env is unreliable); the LAW is positional, not nominal.
  const selfRow = lines.findIndex(l => /● .+ \(you\)/.test(l))
  check('SEAT header pinned at the top (inside its panel border)', seatRow === 2, `row ${seatRow}`)
  check('seat body directly under the header (never dragged)', selfRow === seatRow + 1, `row ${selfRow}`)
  if (selfRow !== seatRow + 1) {
    // Loud red: a future machine-shape miss must name itself in the log.
    console.log('  … rail rows 0-14 (first 44 cols):')
    lines.slice(0, 15).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 44)}`))
  }
  check('RECENT section present', rowOf('RECENT') > 0)
  check('NEXT section present', rowOf('NEXT') > 0)

  // The right telemetry rail: present and top-pinned.
  check('right rail present (USAGE panel)', rowOf('USAGE') >= 0 && rowOf('USAGE') <= 2, `row ${rowOf('USAGE')}`)
}

cleanupScenario('cockpit-scrolled')
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} SCROLL-RAIL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL SCROLL-RAIL PROOFS PASS')
