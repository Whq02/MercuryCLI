#!/usr/bin/env bun
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
    MERCURY_OPERATOR: 'op',
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

  check(
    'scrolled state on screen (jump-to-bottom pill up)',
    rowOf('back to the bottom') > 0 || lines.some(l => / \d+ new message/.test(l)),
  )
  check('transcript top reached (turn 1 visible)', rowOf('turn 1: say something long') > 0)
  const bannerRow = bigWordmarkRows()[0]!.trimEnd()
  check(
    'banner-header revealed at top',
    rowOf(bannerRow) >= 0 || rowOf('Mercury') >= 0,
  )

  const seatRow = rowOf('SEAT')
  const selfRow = lines.findIndex(l => /● .+ \(you\)/.test(l))
  check('SEAT header pinned at the top (inside its panel border)', seatRow === 2, `row ${seatRow}`)
  check('seat body directly under the header (never dragged)', selfRow === seatRow + 1, `row ${selfRow}`)
  if (selfRow !== seatRow + 1) {
    console.log('  … rail rows 0-14 (first 44 cols):')
    lines.slice(0, 15).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 44)}`))
  }
  check('RECENT section present', rowOf('RECENT') > 0)
  check('NEXT section present', rowOf('NEXT') > 0)

  check('right rail present (USAGE panel)', rowOf('USAGE') >= 0 && rowOf('USAGE') <= 2, `row ${rowOf('USAGE')}`)
}

cleanupScenario('cockpit-scrolled')
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} SCROLL-RAIL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL SCROLL-RAIL PROOFS PASS')
