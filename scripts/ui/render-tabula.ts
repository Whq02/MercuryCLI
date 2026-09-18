#!/usr/bin/env bun
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
    MERCURY_CHANNEL_ROOM: `tabula-${tag}-${process.pid}`,
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
console.log(' TABULA render-verify (vshot, the cockpit rail)')
console.log('============================================================')

console.log('\n▶ cockpit rail @120 (solo TABULA glance)')
const h120 = text(capture('resume-2turn', 120, { seedNotesForHelm: true }))
expect('TABULA rail section present (the notepad file\'s own title word)', /TABULA/.test(h120))
expect('top note in the rail', /ship the telemetry/.test(h120))
expect('RECENT glanceable still present (nothing displaced)', /RECENT/.test(h120))

console.log('\n▶ cockpit rail @120 (CLEAN SLATE — default-present card)')
const c120 = text(capture('resume-2turn', 120))
expect('TABULA card present with zero notes (the operator\'s word)', /TABULA/.test(c120))
expect('invitation row teaches /note (untruncated at the 24-col rail)', /no notes — \/note/.test(c120))
expect('NEXT hints still below it', /NEXT/.test(c120))

console.log('\n▶ cockpit rail @120 (KEYLESS CARD — typing lands in the prompt)')
const TAB = String.fromCharCode(9)
const a120raw = capture('resume-2turn', 120, {
  tag: 'keyless-120',
  sends: [
    { atTick: 30, data: TAB },
    { atTick: 40, data: 'close the relay note' },
  ],
  total: 60,
})
const a120 = text(a120raw)
const railText = a120raw.grid.slice(0, 28).map(r => r.slice(0, 25).map(c => c.c || ' ').join('')).join('\n')
expect('typed chars did NOT land in the rail (left region, above the strips)', !/close the relay/.test(railText))
expect('typed chars landed in the prompt', /close the relay note/.test(a120))

console.log('\n▶ busy cockpit @120 (ROUTER UI — card persists)')
const b120busy = text(capture('cockpit-runs', 120, { tag: 'busy-120' }))
expect('busy branch: TABULA card present', /TABULA/.test(b120busy))
expect('busy branch really is busy (CREW lane present)', /CREW/.test(b120busy))

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
expect('count refolds 0 → 1 without a rail event', /TABULA · 1/.test(l120))
expect('the fresh note shows in the card', /live probe/.test(l120))

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ TABULA RENDER PASS' : ` ❌ TABULA RENDER — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
