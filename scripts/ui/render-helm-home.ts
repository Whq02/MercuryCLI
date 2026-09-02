#!/usr/bin/env bun
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

function capture(cols: number, helm: boolean, scenarioName: string = NAME): Grid {
  const tag = scenarioName === NAME ? `${cols}-${helm ? 'on' : 'off'}` : `${scenarioName}-${cols}`
  const gridPath = `/tmp/helm-home-grid-${tag}.json`
  const cfg = { ...scenario(scenarioName, cols, 44), out: gridPath }
  const cfgPath = `/tmp/vshot-helm-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = { ...process.env,
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

console.log('\n▶ cockpit @120 (MERCURY_HELM_HOME=1)')
const c120 = capture(120, true)
const t120 = text(c120)
gridToPng(`/tmp/helm-home-grid-120-on.json`, '/tmp/helm-home-cockpit-120.png').then(r => console.log('  png:', r.path))
expect('SEAT lane header present', /SEAT/.test(t120))
expect('solo RECENT glanceable present', /RECENT/.test(t120))
expect('solo NEXT hints present', /NEXT/.test(t120))
expect('merged TELEMETRY glance present (folded rail leaves the glance)', /TELEMETRY/.test(t120))
expect('glance usage row (5h N%)', /5h \d+%/.test(t120))
expect('glance ctx row (`ctx … · <N>k`)', /ctx .{0,8}· \d+k/.test(t120))
expect('NO full telemetry-rail headers at the folded tier', !/substrate · \d/.test(t120))
expect('welcome fleet-glance line SHED (no "no fleet · trace" dup)', !/no fleet · trace/.test(t120))

console.log('\n▶ both rails @150 (center-first: telemetry rail returns)')
const c150 = capture(150, true)
const t150 = text(c150)
expect('@150: usage telemetry header present', /usage/i.test(t150))
expect('@150: trace telemetry header present', /trace/i.test(t150))
expect('@150: substrate telemetry header present', /substrate/i.test(t150))
expect('@150: ctx-fill gauge present (telemetry rail)', /ctx .{0,8}· \d+k/.test(t150))
expect('@150: SEAT lane still present (both rails)', /SEAT/.test(t150))

console.log('\n▶ degrade @80 (MERCURY_HELM_HOME=1 — rails auto-hidden)')
const d80 = capture(80, true)
const t80 = text(d80)
gridToPng(`/tmp/helm-home-grid-80-on.json`, '/tmp/helm-home-degrade-80.png').then(r => console.log('  png:', r.path))
expect('no SEAT lane header at narrow (rails hidden)', !/SEAT ·/.test(t80))
expect('deck strip present at narrow (ops rail: daemon ○ · fleet ○ · trace N)', /daemon [○●]/.test(t80))
expect('vitals KEPT at narrow (deck 5h gauge — no data loss)', /5h [█░]/.test(t80))

console.log('\n▶ opt-out @120 (MERCURY_HELM_HOME=0 — today\'s deck-strip home)')
const o120 = capture(120, false)
const to120 = text(o120)
gridToPng(`/tmp/helm-home-grid-120-off.json`, '/tmp/helm-home-off-120.png').then(r => console.log('  png:', r.path))
expect('no cockpit lane headers when flag off', !/SEAT ·/.test(to120))
expect('deck strip present when flag off (ops rail)', /daemon [○●]/.test(to120))

cleanupScenario(NAME)

console.log('\n▶ cockpit-wide @120 (long prose — transcript must stay in its column)')
const w120 = capture(120, true, 'cockpit-wide')
const tw = text(w120)
gridToPng('/tmp/helm-home-grid-cockpit-wide-120.json', '/tmp/helm-home-wide-120.png').then(r => console.log('  png:', r.path))
const RAIL_W = 24
const twCenter = w120.grid.map(r => r.map(c => c.c || ' ').join('').slice(RAIL_W)).join('\n')
expect('long prose wrapped (phrase survives across the break)', /indifferent[\s│]+sea/.test(twCenter))
expect('prose NOT broken by a rail glyph (no letter+glyph splice)', !/[a-z][○●◐⚠]/.test(tw))
expect('the fleet-glance dup stays SHED with the cockpit-active context', !/no fleet · trace/.test(tw))

console.log('\n============================================================')
if (failures === 0) console.log('✅ HELM-HOME RENDER PASS')
else console.log(`❌ HELM-HOME RENDER: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
