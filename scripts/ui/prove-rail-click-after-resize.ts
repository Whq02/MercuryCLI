#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '../..')
const SCRATCH = `/tmp/mercury-rail-click-${process.pid}`

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
const rowText = (grid: Grid, r: number): string => (grid[r] ?? []).map(c => c.c).join('')

function rowWith(grid: Grid, needle: string): string | null {
  for (let r = 0; r < grid.length; r++) {
    const text = rowText(grid, r)
    if (text.includes(needle)) return text
  }
  return null
}

function caretOn(grid: Grid, needle: string): boolean {
  const text = rowWith(grid, needle)
  return text !== null && text.startsWith('❯')
}

type Shape = {
  tag: string
  cols: number
  rows: number
  shrink: { cols: number; rows: number }
  grow: { cols: number; rows: number }
  storm: Array<{ cols: number; rows: number }>
  env: Record<string, string>
}
const SHAPES: Shape[] = [
  {
    tag: 'deployed-default',
    cols: 120, rows: 40,
    shrink: { cols: 120, rows: 32 },
    grow: { cols: 120, rows: 48 },
    storm: [
      { cols: 120, rows: 44 }, { cols: 110, rows: 36 },
      { cols: 124, rows: 42 }, { cols: 116, rows: 38 },
    ],
    env: {},
  },
  {
    tag: 'apple-terminal',
    cols: 128, rows: 36,
    shrink: { cols: 128, rows: 30 },
    grow: { cols: 128, rows: 44 },
    storm: [
      { cols: 128, rows: 40 }, { cols: 118, rows: 32 },
      { cols: 132, rows: 38 }, { cols: 122, rows: 33 },
    ],
    env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color', TERM_PROGRAM_VERSION: '455' },
  },
]

const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const SHRINK_AT = 70
const GROW_AT = 110
const tk = (authored: number): number => Math.round(authored * vshotBudgetScale())
const STORM_AT = 140

mkdirSync(SCRATCH, { recursive: true })

for (const shape of SHAPES) {
  console.log(`\n── shape: ${shape.tag} (${shape.cols}x${shape.rows})`)
  const home = join(SCRATCH, `home-${shape.tag}`)
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [ROOT])

  const out = join(SCRATCH, `${shape.tag}.json`)
  const cfg = {
    argv: ['node', join(ROOT, 'dist/mercury.mjs')],
    cols: shape.cols, rows: shape.rows, total: 250,
    out,
    resizes: [
      { atTick: SHRINK_AT, ...shape.shrink },
      { atTick: GROW_AT, ...shape.grow },
      ...shape.storm.map((s, i) => ({ atTick: STORM_AT + i, ...s })),
    ],
    sends: [
      { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
      { atTick: 999, requireAwait: true, awaitText: 'shortcuts', minTick: 4, awaitSettleTicks: 8, data: '\x1b[I', mark: 'chat' },
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: 2, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'warmup' },
      { atTick: 999, requireAwait: true, awaitText: 'no notes', minTick: 2, awaitSettleTicks: 3, targetText: 'no notes', data: CLICK, mark: 'click1' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ✧ no notes', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after1' },
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: SHRINK_AT + 3, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'click2' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ❯ ask minerva', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after2' },
      { atTick: 999, requireAwait: true, awaitText: 'no notes', minTick: GROW_AT + 3, awaitSettleTicks: 3, targetText: 'no notes', data: CLICK, mark: 'click3' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ✧ no notes', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after3' },
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: STORM_AT + 6, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'click4' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ❯ ask minerva', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after4' },
    ],
  }
  const cfgPath = join(SCRATCH, `${shape.tag}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(420000), cwd: ROOT,
    env: { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: FIXTURE_API_KEY, ...shape.env },
  })
  check(`${shape.tag}: drive exits 0`, res.status === 0, `status ${res.status}: ${(res.stdout ?? '').slice(-500)}`)
  const undelivered = /UNDELIVERED-SENDS/.test(res.stdout ?? '')
  check(`${shape.tag}: every send became due (clicks resolved on the live grid)`, !undelivered,
    (res.stdout ?? '').split('\n').filter(l => l.includes('UNDELIVERED')).join(' '))
  if (res.status !== 0 || undelivered) continue

  const payload = JSON.parse(readFileSync(out, 'utf-8')) as { marks: Mark[] }
  const mark = (label: string): Mark | undefined => payload.marks.find(m => m.label === label)
  const after1 = mark('after1')
  const after2 = mark('after2')
  const after3 = mark('after3')
  const after4 = mark('after4')
  const click2 = mark('click2')

  check(`${shape.tag}: phase 1 closed before the shrink`, (after1?.atTick ?? 999) < tk(SHRINK_AT), `after1 @${after1?.atTick}`)
  check(`${shape.tag}: phase 2 fired after the shrink and closed before the grow`,
    (click2?.atTick ?? 0) > tk(SHRINK_AT) && (after2?.atTick ?? 999) < tk(GROW_AT),
    `click2 @${click2?.atTick} after2 @${after2?.atTick}`)

  check(`${shape.tag}: pre-resize click claims the notes row`,
    after1 !== undefined && caretOn(after1.grid, 'no notes'),
    after1 ? JSON.stringify(rowWith(after1.grid, 'no notes')) : 'no after1 mark')

  check(`${shape.tag}: post-shrink click claims the minerva row`,
    after2 !== undefined && caretOn(after2.grid, 'ask minerva'),
    after2 ? JSON.stringify(rowWith(after2.grid, 'ask minerva')) : 'no after2 mark')
  check(`${shape.tag}: post-shrink the notes row released the caret`,
    after2 !== undefined && !caretOn(after2.grid, 'no notes'),
    after2 ? JSON.stringify(rowWith(after2.grid, 'no notes')) : 'no after2 mark')

  check(`${shape.tag}: post-grow click claims the notes row again`,
    after3 !== undefined && caretOn(after3.grid, 'no notes'),
    after3 ? JSON.stringify(rowWith(after3.grid, 'no notes')) : 'no after3 mark')
  check(`${shape.tag}: post-grow the minerva row released the caret`,
    after3 !== undefined && !caretOn(after3.grid, 'ask minerva'),
    after3 ? JSON.stringify(rowWith(after3.grid, 'ask minerva')) : 'no after3 mark')

  check(`${shape.tag}: post-storm click claims the minerva row`,
    after4 !== undefined && caretOn(after4.grid, 'ask minerva'),
    after4 ? JSON.stringify(rowWith(after4.grid, 'ask minerva')) : 'no after4 mark')
  check(`${shape.tag}: post-storm the notes row released the caret`,
    after4 !== undefined && !caretOn(after4.grid, 'no notes'),
    after4 ? JSON.stringify(rowWith(after4.grid, 'no notes')) : 'no after4 mark')

}

if (failures > 0) {
  console.log(`\nrail click after resize: RED (${failures}/${checks}) — artifacts at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nrail click after resize: green (${checks} checks)`)
