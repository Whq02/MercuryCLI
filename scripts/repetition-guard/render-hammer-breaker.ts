#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const CONFIG_HOME = join(tmpdir(), `hammer-render-home-${process.pid}`)
mkdirSync(CONFIG_HOME, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' repetition breaker — the warning on the real cockpit')
console.log('============================================================')

if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists (build first)', false)
  process.exit(1)
}

const FIX = join(tmpdir(), `hammer-render-fix-${process.pid}`)
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# hammer breaker capture fixture\n')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
process.env.ANTHROPIC_API_KEY = 'proof-key-hammer-scripted-stream'
seedFirstRun(CONFIG_HOME, [FIX, realpathSync(FIX)])
const { IDENTICAL_FAILURES_TO_STOP, IDENTICAL_RETRY_NUDGE } = await import('../../src/services/tools/identicalFailureGuard.ts')
const { HAMMER_BREAKER_FILE } = await import('../../src/query/scriptedStream.ts')

const SCRATCH = (name: string) => join(tmpdir(), `hammer-render-${name}-${process.pid}`)
const gridPath = join(tmpdir(), `hammer-render-grid-${process.pid}.json`)
const cfgPath = join(tmpdir(), `hammer-render-vshot-${process.pid}.json`)
writeFileSync(
  cfgPath,
  JSON.stringify({
    argv: ['node', BIN],
    cwd: FIX,
    sends: [
      { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
      { atTick: 90, minTick: 5, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: 'please list that directory\r' },
    ],
    total: 170,
    cols: 140,
    rows: 50,
    out: gridPath,
  }),
)

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf8',
  timeout: vshotBudgetMs(180_000),
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: 'proof-key-hammer-scripted-stream',
    MERCURY_SCRIPTED_STREAM: 'hammer-breaker',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_DAEMON_DIR: SCRATCH('daemon'),
    MERCURY_TEAMS_DIR: SCRATCH('teams'),
    MERCURY_TABULA_DIR: SCRATCH('tabula'),
    MERCURY_HOME: SCRATCH('home'),
    VISUAL: '',
    EDITOR: '',
  },
})
if (res.status !== 0) {
  check('PTY capture ran', false, (res.stderr ?? '').slice(0, 300))
  process.exit(1)
}

type Cell = { c: string }
const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
const lines = grid.map(r => r.map(c => c.c).join(''))
const screen = lines.join('\n')
const flat = screen.replace(/\s+/g, ' ')

check('frame is painted (no all-blank grid)', screen.replace(/\s/g, '').length > 400)
check('the prompt was sent (the transcript carries it)', flat.includes('please list that directory'), screen.slice(0, 1200))
check('the hammered reads painted as the collapsed read row', flat.includes('Read 1 file') || flat.includes(HAMMER_BREAKER_FILE.slice(0, 30)), screen.slice(0, 1500))
check("the breaker's warning is on the screen: stopped, the tool, the streak", flat.includes('Stopped this turn') && flat.includes('identical Read call') && flat.includes(`${IDENTICAL_FAILURES_TO_STOP} times`), flat.slice(-1200))
check('…and the next move', flat.includes('new prompt'), flat.slice(-600))
check('the warning wears the warn lead (a stopped turn is a warning, not an alarm)', lines.some(l => /▲\s*Stopped this turn/.test(l)), lines.filter(l => l.includes('Stopped')).join('\n'))
check('the model-facing nudge is the one the guard states (the screen row is its collapsed group)', IDENTICAL_RETRY_NUDGE.startsWith('Refusing to run this exact call again'))
check('the cockpit returned to the composer (the turn ended, nothing spins)', lines.some(l => l.includes('❯')), lines.slice(-6).join('\n'))

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ HAMMER BREAKER RENDER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} HAMMER BREAKER RENDER FAILURE(S)`)
console.log(screen)
process.exit(1)
