#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argument('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = argument('--frames')
const SCRATCH = join(realpathSync('/tmp'), `mercury-rail-mission-${process.pid}`)
const MISSION = 'relay probe'
const BUDGET_TICKS = 3

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
const rowText = (grid: Grid, r: number): string => (grid[r] ?? []).map(c => c.c).join('')
const textOf = (grid: Grid): string => grid.map((_, r) => rowText(grid, r).trimEnd()).join('\n')
const missionRow = (grid: Grid): string | null => {
  for (let r = 0; r < grid.length; r++) {
    const text = rowText(grid, r)
    if (text.includes(`\u25c6 ${MISSION}`)) return text
  }
  return null
}

if (!existsSync(DIST)) throw new Error(`Built bundle absent: ${DIST}`)
mkdirSync(SCRATCH, { recursive: true })
const home = join(SCRATCH, 'home')
const cwd = join(SCRATCH, 'work')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [cwd])
const out = join(SCRATCH, 'grid.json')
const cfg = {
  argv: ['node', DIST],
  cwd,
  cols: 120,
  rows: 40,
  total: 200,
  out,
  liveSeat: true,
  sends: [
    { requireAwait: true, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, data: '\r', mark: 'face' },
    { requireAwait: true, awaitText: 'Type a prompt', minTick: 4, awaitSettleTicks: 2, data: '', mark: 'composer' },
    { requireAwait: true, awaitText: ' ready \u00b7 ', minTick: 1, awaitSettleTicks: 3, data: `/mission ${MISSION}\r`, mark: 'sent' },
    { afterPrevTicks: 1, data: '', mark: 'plus1' },
    { afterPrevTicks: BUDGET_TICKS - 1, data: '', mark: 'budget' },
    { afterPrevTicks: 40 - BUDGET_TICKS, data: '', mark: 'plus40' },
    { afterPrevTicks: 2, data: '\t', mark: 'tab' },
    { afterPrevTicks: 6, data: '', mark: 'after-tab' },
  ],
}
const cfgPath = join(SCRATCH, 'capture.json')
writeFileSync(cfgPath, JSON.stringify(cfg))
console.log(`build under proof: ${DIST}`)
const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(240_000),
  cwd,
  env: {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
    BROWSER: '/usr/bin/true',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
  },
})
const engineLog = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
writeFileSync(join(SCRATCH, 'engine.log'), engineLog)
check('the capture ran to its end', res.status === 0 && existsSync(out), `status ${res.status}: ${engineLog.trim().split('\n').slice(-3).join(' | ')}`)
const undelivered = /UNDELIVERED-SENDS/.test(engineLog)
check('every send became due', !undelivered, engineLog.split('\n').filter(l => l.includes('UNDELIVERED')).join(' '))
if (res.status === 0 && existsSync(out) && !undelivered) {
  const payload = JSON.parse(readFileSync(out, 'utf-8')) as { marks: Mark[] }
  const mark = (label: string): Mark | undefined => payload.marks.find(m => m.label === label)
  const sent = mark('sent')
  const plus1 = mark('plus1')
  const budget = mark('budget')
  const plus40 = mark('plus40')
  const afterTab = mark('after-tab')
  for (const m of [sent, plus1, budget, plus40, afterTab]) if (m) writeFileSync(join(SCRATCH, `${m.label}.txt`), `${textOf(m.grid)}\n`)
  check('the seat was ready before the command (the hosted chat held the slot, so the mission arms under its id)', sent !== undefined && textOf(sent.grid).includes(' ready \u00b7 '), sent ? textOf(sent.grid).split('\n').filter(l => l.includes('work')).join(' | ') : 'no mark')
  check('the mission command was taken (its result row paints)', sent !== undefined && budget !== undefined && textOf(budget.grid).includes(`Mission set: ${MISSION}`), budget ? textOf(budget.grid).split('\n').filter(l => l.includes('Mission')).join(' | ') : 'no mark')
  check(`the MISSION card paints within the rail's own repaint budget (${BUDGET_TICKS} ticks after /mission) with no other input`, budget !== undefined && missionRow(budget.grid) !== null, budget ? `no "\u25c6 ${MISSION}" row at tick ${budget.atTick}` : 'no mark')
  check('…and stands 40 ticks later', plus40 !== undefined && missionRow(plus40.grid) !== null, plus40 ? `absent at tick ${plus40.atTick}` : 'no mark')
  check('a Tab into the rail shows the same row (the mission was armed all along)', afterTab !== undefined && missionRow(afterTab.grid) !== null, afterTab ? textOf(afterTab.grid).slice(0, 400) : 'no mark')
  console.log(`  first sight: plus1=${plus1 ? String(missionRow(plus1.grid) !== null) : '?'} budget=${budget ? String(missionRow(budget.grid) !== null) : '?'} plus40=${plus40 ? String(missionRow(plus40.grid) !== null) : '?'} after-tab=${afterTab ? String(missionRow(afterTab.grid) !== null) : '?'}`)
}
if (FRAMES) {
  mkdirSync(resolve(FRAMES), { recursive: true })
  for (const name of ['sent.txt', 'plus1.txt', 'budget.txt', 'plus40.txt', 'after-tab.txt', 'grid.json', 'capture.json', 'engine.log']) {
    const file = join(SCRATCH, name)
    if (existsSync(file)) writeFileSync(join(resolve(FRAMES), name), readFileSync(file))
  }
}
if (failures > 0) {
  console.log(`\nrail mission birth: RED (${failures}/${checks}) — artifacts at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nrail mission birth: green (${checks} checks)`)
