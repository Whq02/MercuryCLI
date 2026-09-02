#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' helm console render — the section paints in the real binary')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
const GRID = join(tmpdir(), `helm-console-grid-${process.pid}.json`)
const res = spawnSync(
  process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`,
  [
    'run',
    join(ROOT, 'scripts/ui/render-tui.ts'),
    '--scenario', 'cockpit-console',
    '--cols', '160',
    '--rows', '50',
    '--out', join(tmpdir(), `helm-console-${process.pid}.png`),
    '--grid', GRID,
  ],
  { encoding: 'utf8', timeout: 150_000, cwd: ROOT },
)
if (res.status !== 0) {
  console.log(`  [FAIL] render-tui exited ${res.status}: ${res.stderr?.slice(0, 400)}`)
  console.log('❌ prove-console-render: capture failed')
  process.exit(1)
}

type Grid = { grid: Array<Array<{ c: string }>> }
const g = JSON.parse(readFileSync(GRID, 'utf8')) as Grid
const lines = g.grid.map(row => row.map(c => c.c ?? '').join(''))
const text = lines.join('\n')

const traceLine = lines.findIndex(l => l.includes('TRACE'))
const conLine = lines.findIndex(l => l.includes('CONSOLE'))
check('trace section painted', traceLine >= 0)
check('console section painted', conLine >= 0)
check('console renders UNDER trace (the last section)', traceLine >= 0 && conLine > traceLine, `trace@${traceLine} con@${conLine}`)
check('typed buffer landed in the console line', text.includes('what changed here'))
const bufLine = lines.find(l => l.includes('what changed here')) ?? ''
check('…with the ❯ REPL prompt', bufLine.includes('❯'))
check('…and the ▌ block cursor', bufLine.includes('▌'))
check('compose hint advertises armed keys', text.includes('↵ ask'))
const occurrences = lines.filter(l => l.includes('what changed here')).length
check('text appears exactly once (never leaked to the prompt)', occurrences === 1, `n=${occurrences}`)

check('TASKS header carries done/total', text.includes('TASKS · 1/4'))
check('in-progress row narrates the activeForm', text.includes('Charting the reef'))
check('queued rows render subjects', text.includes('Refit the tide') && text.includes('Sound the harb'))
check('completed task not listed as a row', !text.includes('Stow the survey'))

console.log(`  (png: /tmp/helm-console-160.png)`)
console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-render: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-render: ALL GREEN')
