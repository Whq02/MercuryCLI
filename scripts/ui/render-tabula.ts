#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-tabula.ts — render-verify for the TABULA notepad
//  (the /tabula board + the Helm cockpit's TABULA rail glance).
//
//  Verify-by-RENDERING: drives the real dist binary in a pyte PTY
//  (vshot) and asserts the structural markers a broken layout would lose:
//
//    room @120 ('tabula')       : Minerva's room
//                                 — chrome, the honest unset
//                                 line, the saved-prompts + conversation
//                                 sections, the composer line; the seeded
//                                 notes stay on disk and never paint.
//    room @80   ('tabula')      : chrome intact at narrow, esc close visible.
//    empty @80  ('tabula-empty'): the honest no-saved-prompts line.
//    cockpit @120 (resume-2turn + seeded journal): the solo rail grows a
//                                 TABULA section with the top notes.
//    cockpit @120 (resume-2turn, UNSEEDED): the DEFAULT-PRESENT card — a
//                                 clean slate shows the /note invitation row
// never an absent card.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-tabula.ts   (dist must exist —
//  the ui suite's phase-0 prebuild or a manual `bun run build.ts`)
//  Out:  /tmp/tabula-render-*.png + a PASS/FAIL summary.
// ============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const REPO = join(import.meta.dir, '..', '..')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

const painted = (g: Grid) => g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)
const text = (g: Grid) => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function capture(
  name: string,
  cols: number,
  opts?: { seedNotesForHelm?: boolean; sends?: Array<{ atTick: number; data: string }>; total?: number; tag?: string },
): Grid {
  const tag = opts?.tag ?? `${name}-${cols}${opts?.seedNotesForHelm ? '-seeded' : ''}`
  const gridPath = `/tmp/tabula-render-grid-${tag}.json`
  const cfg = { ...scenario(name, cols, 44), out: gridPath }
  if (opts?.sends) {
    cfg.sends = opts.sends
    if (opts.total) cfg.total = opts.total
  }
  // The helm leg reuses the fullscreen-home scenario and seeds the notepad
  // AFTER scenario() pinned MERCURY_TABULA_DIR (the rail folds it live).
  if (opts?.seedNotesForHelm) {
    const slug = REPO.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(process.env.MERCURY_TABULA_DIR!, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'journal.jsonl'),
      [
        { t: '2026-07-08T09:00:00Z', op: 'add', id: 'aa11bb', text: 'ship the telemetry board', pri: 'now' },
        { t: '2026-07-08T09:01:00Z', op: 'add', id: 'bb22cc', text: 'benchmark the pooled gate' },
      ]
        .map(e => JSON.stringify(e))
        .join('\n') + '\n',
    )
  }
  const cfgPath = `/tmp/vshot-tabula-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    ...(opts?.seedNotesForHelm ? { MERCURY_HELM_HOME: '1' } : {}),
  }
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(60000), env })
    if (res.status !== 0) continue
    grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
    if (painted(grid) >= 40) break
  }
  cleanupScenario(name)
  void gridToPng(gridPath, `/tmp/tabula-render-${tag}.png`).then(r => console.log('  png:', r.path))
  return grid
}

let failures = 0
function expect(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' TABULA render-verify (vshot, 80 & 120 + cockpit rail)')
console.log('============================================================')

// /tabula is MINERVA'S ROOM: the
// seeded note journal stays on disk and the room offers no note-leaving —
// the legs below read the room's own chrome (the notes never paint here).
console.log("\n▶ Minerva's room @120 (notes seeded on disk, none offered)")
const b120 = text(capture('tabula', 120))
const room120 = b120.slice(b120.indexOf("Minerva's room"))
expect("room chrome (Mercury — tabula · Minerva's room)", /tabula/.test(b120) && /Minerva's room/.test(b120))
expect('the honest unset line (no Minerva model pinned in a capture home)', /no Minerva model set/.test(room120))
expect('the saved-prompts section + the conversation section render', /saved prompts \(/.test(room120) && /the conversation \(/.test(room120))
expect('the console-shaped composer line', /message minerva/.test(room120) && /↵ ask minerva/.test(room120))
expect('the seeded NOTES do not paint in the room (no note-leaving, no note list)', !/ship the telemetry board/.test(room120) && !/a add/.test(room120))

console.log("\n▶ Minerva's room @80 (narrow holds)")
const b80 = text(capture('tabula', 80))
const room80 = b80.slice(b80.indexOf("Minerva's room"))
expect('@80: chrome + sections intact', /Minerva's room/.test(b80) && /saved prompts \(/.test(room80))
expect('@80: esc close visible', /esc close/.test(room80))

console.log("\n▶ Minerva's room @80 (no saved prompts)")
const e80 = text(capture('tabula-empty', 80))
const roomE80 = e80.slice(e80.indexOf("Minerva's room"))
expect('honest empty state for saved prompts', /no saved prompts yet/.test(roomE80))
expect('the hint names the prompts panel, never /note', /\/workbench/.test(roomE80) && !/\/note/.test(roomE80))

console.log('\n▶ cockpit rail @120 (solo TABULA glance)')
const h120 = text(capture('resume-2turn', 120, { seedNotesForHelm: true }))
expect('MINERVA rail section present (the re-pointed header)', /MINERVA/.test(h120))
expect('top note in the rail', /ship the telemetry/.test(h120))
expect('RECENT glanceable still present (nothing displaced)', /RECENT/.test(h120))

console.log('\n▶ cockpit rail @120 (CLEAN SLATE — default-present card)')
const c120 = text(capture('resume-2turn', 120))
expect('MINERVA card present with zero notes (the operator's word)', /MINERVA/.test(c120))
expect('invitation row teaches /note (untruncated at the 24-col rail)', /no notes — \/note/.test(c120))
expect('NEXT hints still below it', /NEXT/.test(c120))

// The ask line (unbilled compose leg): Tab into lanes, ↓ to the TABULA ask
// row, type — the printable must auto-compose INTO the rail (not the prompt)
// and the focus banner must flip to the minerva grammar. No ↵ ⇒ zero cost.
console.log('\n▶ cockpit rail @120 (ASK LINE — compose in place, unbilled)')
const TAB = String.fromCharCode(9)
const DOWN = String.fromCharCode(27) + '[B'
// Row model in this scenario: seat:self(0) · RECENT ×3 (1-3) · tabula:empty(4)
// · tabula:ask(5) — ↓×5 rests the cursor on the ask line.
const a120raw = capture('resume-2turn', 120, {
  tag: 'askline-120',
  sends: [
    { atTick: 30, data: TAB },
    { atTick: 34, data: DOWN.repeat(5) },
    { atTick: 40, data: 'close the relay note' },
  ],
  total: 60,
})
const a120 = text(a120raw)
// Region honesty: the rail is the left ~25 cols — the same needle in the
// prompt (full width, bottom) must NOT count as "landed in the rail".
const railText = a120raw.grid.map(r => r.slice(0, 25).map(c => c.c || ' ').join('')).join('\n')
expect('typed chars landed IN THE RAIL (left region), not the prompt', /close the relay/.test(railText))
expect('focus banner flips to the minerva grammar', /↵ send/.test(a120))

// Router-UI persistence: the BUSY branch (a running
// process ⇒ never solo) must render the TABULA card + ask line too.
console.log('\n▶ busy cockpit @120 (ROUTER UI — card persists)')
const b120busy = text(capture('cockpit-runs', 120, { tag: 'busy-120' }))
expect('busy branch: MINERVA card present', /MINERVA/.test(b120busy))
expect('busy branch: the ask line rides along', /ask minerva/.test(b120busy))
expect('busy branch really is busy (CREW lane present)', /CREW/.test(b120busy))

// Liveness: a /note typed at the prompt must repaint the card in the SAME
// frame stream (the every-mutation-origin bump; caught stale by the chat
// E2E's final frame). /note is zero-model — unbilled.
console.log('\n▶ cockpit rail @120 (LIVENESS — /note repaints the card)')
const l120 = text(
  capture('resume-2turn', 120, {
    tag: 'liveness-120',
    sends: [
      { atTick: 30, data: '/note live probe' },
      { atTick: 40, data: '\r' },
    ],
    total: 80,
  }),
)
expect('count refolds 0 → 1 without a rail event', /MINERVA · 1/.test(l120))
expect('the fresh note shows in the card', /live probe/.test(l120))

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ TABULA RENDER PASS' : ` ❌ TABULA RENDER — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
