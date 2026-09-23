import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cellColor,
  CRITTERS,
  critterDefForKey,
} from '../../src/utils/cockpit/critterData.js'
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

{
  const home = read('src/components/MercuryHome.tsx')
  const berth = home.slice(home.indexOf('export function PinnedCritterBerth'))
  const berthBody = berth.slice(0, berth.indexOf('\nexport ', 1))
  t('berth binds no grid over the def', !/square:\s*[A-Za-z]/.test(berthBody))
  t('berth passes square= to AnimatedCritterArt', /AnimatedCritterArt def=\{hover \? hoverDockDef : dockDef\} square \/>/.test(berthBody))
  t('berth pins its slot to the dock height', berthBody.includes('height={SQUARE_DOCK_ART_LINES}'))
  const layout = read('src/components/FullscreenLayout.tsx')
  t('the statusBand card mounts PinnedCritterBerth', layout.includes('<PinnedCritterBerth />'))
}

const ALL = [...CRITTERS]
for (const def of ALL) {
  t(`${def.name}: flat art carries NO 'K' (oracle stays sound)`, !def.art.some(r => r.includes('K')))
  t(`${def.name}: the dock grid carries 'K' pupils`, def.squareDock.some(r => r.includes('K')))
}

type GridCell = { c: string; fg: string; bg: string }
type Grid = { grid: GridCell[][] }

function capture(tag: string): Grid {
  const cfg = scenario('resume-2turn', 120, 44)
  const out = `/tmp/berth-sprite-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/berth-sprite-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends: [], total: 55, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '..', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CRITTER: 'crab',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  return JSON.parse(readFileSync(out, 'utf8')) as Grid
}

const PUPIL_HEX = norm(cellColor(critterDefForKey('crab'), 'K'))

function pupilCellsInBerthRegion(g: Grid): number {
  let hits = 0
  const rows = Math.min(14, g.grid.length)
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
    hits = pupilCellsInBerthRegion(capture('b'))
  }
  t('cockpit berth renders the dock sprite (K-pupil mix on screen, top region)', hits > 0, `pupil cells=${hits}`)
}

console.log(failures === 0 ? '✅ berth-sprite contract holds' : '❌ berth-sprite contract BROKEN')
process.exit(failures)
