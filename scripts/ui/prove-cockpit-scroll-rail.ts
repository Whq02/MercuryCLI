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

const scrolledCfg = scenario('cockpit-scrolled', 150, 40)
const PAGE_DOWN = '\x1b[6~'
const cfg = {
  ...scrolledCfg,
  sends: [
    ...scrolledCfg.sends,
    { afterPrevTicks: 4, awaitStableTicks: 3, data: PAGE_DOWN, mark: 'scrolled' },
    ...Array.from({ length: 13 }, () => ({ afterPrevTicks: 2, data: PAGE_DOWN })),
  ],
  total: 210,
}

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
  },
})
check('PTY capture ran', res.status === 0, res.stderr?.slice(0, 200) ?? '')

if (res.status === 0) {
  const grid = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
    marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
  }
  const rowsOf = (g: Array<Array<{ c: string }>>): string[] => g.map(r => r.map(c => c.c).join(''))
  const lines = rowsOf(grid.marks?.find(m => m.label === 'scrolled')?.grid ?? [])
  const bottom = rowsOf(grid.grid)
  const rowOf = (needle: string): number => lines.findIndex(l => l.includes(needle))
  const bottomRowOf = (needle: string): number => bottom.findIndex(l => l.includes(needle))
  check('the scrolled frame was taken', lines.length > 0)

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

  const recentRow = rowOf('RECENT')
  const bodyRow = lines.findIndex(l => /│\s+○ .+/.test(l.slice(0, 44)))
  check('RECENT header pinned at the top (inside its panel border)', recentRow === 2, `row ${recentRow}`)
  check('the recent body directly under the header (never dragged)', bodyRow === recentRow + 1, `row ${bodyRow}`)
  if (bodyRow !== recentRow + 1) {
    console.log('  … rail rows 0-14 (first 44 cols):')
    lines.slice(0, 15).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 44)}`))
  }
  check('no SEAT box in the rail (the retired presence estate)', rowOf('SEAT ·') === -1 && !lines.some(l => /\(you\)/.test(l)))
  check('NEXT section present', rowOf('NEXT') > 0)

  check('right rail present (USAGE panel)', rowOf('USAGE') >= 0 && rowOf('USAGE') <= 2, `row ${rowOf('USAGE')}`)

  check('PageDown back to the bottom clears the pill', bottomRowOf('back to the bottom') === -1 && !bottom.some(l => / \d+ new message/.test(l)))
  check('the bottom is back (the last reply on screen)', bottomRowOf('Reply 18:') > 0)
  const bottomRecentRow = bottomRowOf('RECENT')
  const bottomBodyRow = bottom.findIndex(l => /│\s+○ .+/.test(l.slice(0, 44)))
  check('RECENT header still pinned after the return scroll', bottomRecentRow === 2, `row ${bottomRecentRow}`)
  check('the recent body still under its header after the return scroll', bottomBodyRow === bottomRecentRow + 1, `row ${bottomBodyRow}`)
  check('right rail still top-pinned after the return scroll', bottomRowOf('USAGE') >= 0 && bottomRowOf('USAGE') <= 2, `row ${bottomRowOf('USAGE')}`)
}

cleanupScenario('cockpit-scrolled')
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} SCROLL-RAIL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL SCROLL-RAIL PROOFS PASS')
