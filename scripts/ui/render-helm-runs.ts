#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const NAME = 'cockpit-runs'
const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

function capture(cols: number, scenarioName: string = NAME): Grid {
  const tag = scenarioName === NAME ? String(cols) : `${scenarioName}-${cols}`
  const gridPath = `/tmp/helm-runs-grid-${tag}.json`
  const cfg = { ...scenario(scenarioName, cols, 44), out: gridPath }
  const cfgPath = `/tmp/vshot-helm-runs-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_HELM_HOME: '1',
  }
  const painted = (g: Grid) =>
    g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(60000),
      env,
    })
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
console.log(' Helm RUNS lane render-verify (real backgrounded shell @120)')
console.log('============================================================')

const g = capture(120)
const t = text(g)
void gridToPng('/tmp/helm-runs-grid-120.json', '/tmp/helm-runs-120.png').then(r =>
  console.log('  png:', r.path),
)

expect(
  'shell was genuinely backgrounded (the ctrl+b receipt in the transcript)',
  /manually backgrounded by user/.test(t),
)
expect('RUNS section header present (`RUNS · 1 live`)', /RUNS · 1 live/.test(t))
expect('run row carries a work glyph before the title', /[◐◓◑◒] sleep 300/.test(t))
expect('run row verb is `shell <elapsed>`', /sleep 300 · shell \d+[sm]/.test(t))
expect('busy branch: CREW lane present', /CREW ·/.test(t))
expect('solo NEXT hints replaced by the busy layout', !/NEXT/.test(t))
expect('TASKS header is ledger-only (no `· N open` conflation)', /TASKS(?! · \d+ open)/.test(t))

console.log('\n▶ drill: ↵ on the RUNS row opens the process card')
const d = text(capture(120, 'cockpit-runs-drill'))
expect('the SPECIFIC process card opened (Mercury — shell header)', /Mercury — shell/.test(d))
expect('card state row is the live spine (`running · <t>`)', /running · \d+[sm]/.test(d))
expect('card carries the command', /command\s+sleep 300/.test(d))
expect('card footer advertises the REAL keys (esc/↵ close)', /esc\/↵ close/.test(d))
expect('the section rule stays INSIDE the card border (no │── overrun)', !/─│─/.test(d) && !/──│ /.test(d))

console.log('\n▶ drill-esc: esc closes the card back to the cockpit')
const e = text(capture(120, 'cockpit-runs-drill-esc'))
expect('esc dismissed the card (no shell header)', !/Mercury — shell/.test(e))
expect('back on the cockpit (RUNS lane present again)', /RUNS · 1 live/.test(e))

cleanupScenario(NAME)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
