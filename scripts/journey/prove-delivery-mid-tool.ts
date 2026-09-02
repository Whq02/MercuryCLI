#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const CONFIG_HOME = join(tmpdir(), `midtool-drill-home-${process.pid}`)
mkdirSync(CONFIG_HOME, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the delivery drill — a mid-tool send lands once, the stop speaks')
console.log('============================================================')

if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists (build first)', false)
  process.exit(1)
}

const FIX = join(tmpdir(), `midtool-drill-fix-${process.pid}`)
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# mid-tool drill fixture\n')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(CONFIG_HOME, [FIX, realpathSync(FIX)])

const MID = 'mid tool words xyzzy'
const gridPath = join(tmpdir(), `midtool-drill-grid-${process.pid}.json`)
const cfgPath = join(tmpdir(), `midtool-drill-cfg-${process.pid}.json`)
writeFileSync(
  cfgPath,
  JSON.stringify({
    argv: ['node', BIN],
    cwd: FIX,
    sends: [
      { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
      { atTick: 90, minTick: 5, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: 'please list that directory\r' },
      { atTick: 160, minTick: 5, awaitText: 'definitely-missing', awaitSettleTicks: 2, data: `${MID}\r` },
    ],
    total: 200,
    cols: 140,
    rows: 50,
    out: gridPath,
  }),
)

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf8',
  timeout: 240_000,
  env: {
    ...process.env,
    MERCURY_SCRIPTED_STREAM: 'hammer-breaker',
    MERCURY_OPERATOR: 'sam',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_DAEMON_DIR: join(tmpdir(), `midtool-drill-daemon-${process.pid}`),
    MERCURY_TEAMS_DIR: join(tmpdir(), `midtool-drill-teams-${process.pid}`),
    MERCURY_TABULA_DIR: join(tmpdir(), `midtool-drill-tabula-${process.pid}`),
    MERCURY_HOME: join(tmpdir(), `midtool-drill-home2-${process.pid}`),
    VISUAL: '',
    EDITOR: '',
  },
})
if (res.status !== 0) {
  check('PTY capture ran', false, `exit=${res.status} ${(res.stderr ?? '').slice(0, 300)}`)
  process.exit(1)
}

type Cell = { c: string }
const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
const lines = grid.map(r => r.map(c => c.c).join(''))
const screen = lines.join('\n')
const flat = screen.replace(/\s+/g, ' ')

check('M1 the drive ran (the first prompt is on the glass)', flat.includes('please list that directory'), screen.slice(0, 800))

const paintCount = lines.filter(l => /\[sam\] ❯ mid tool words xyzzy/.test(l)).length
check('M2 the mid-tool message paints EXACTLY ONCE in the transcript (delivered, never doubled, never vanished)', paintCount === 1, `nameplated rows=${paintCount}`)

{
  let rows = 0
  let files = 0
  const projectsDir = join(CONFIG_HOME, 'projects')
  try {
    for (const proj of readdirSync(projectsDir)) {
      for (const f of readdirSync(join(projectsDir, proj))) {
        if (!f.endsWith('.jsonl')) continue
        files++
        for (const line of readFileSync(join(projectsDir, proj, f), 'utf8').split('\n')) {
          if (!line.includes(MID)) continue
          try {
            const rec = JSON.parse(line) as { payload?: { kind?: string } }
            const kind = rec.payload?.kind
            if (kind === 'input' || kind === 'attachment') rows++
          } catch {
          }
        }
      }
    }
  } catch {
  }
  check('M3 the transcript store carries it exactly once', files > 0 && rows === 1, `files=${files} rows=${rows}`)
}

for (const poison of ['steering', 'queued —', 'waits for the next turn', 'Tab queues', 'holds for the next turn']) {
  check(`M4 the glass never says '${poison}'`, !flat.includes(poison))
}

check('M5 the breaker warning is on the glass (stopped + the tool + the streak)', /Stopped this turn/.test(flat) && /identical Read call/.test(flat), flat.slice(-600))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`DELIVERY-MID-TOOL: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('DELIVERY-MID-TOOL: all checks passed')
process.exit(0)
