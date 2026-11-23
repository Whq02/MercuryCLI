#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
let missionHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, missionHint].filter(Boolean).join('; ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`

type Grid = { grid: Array<Array<{ c: string }>> }
function capture(scenario: string, cols: number, rows: number): string[] | null {
  const res = spawnSync(
    BUN,
    [
      'run',
      join(ROOT, 'scripts/ui/render-tui.ts'),
      '--scenario', scenario,
      '--cols', String(cols),
      '--rows', String(rows),
      '--out', `/tmp/prove-tasks-mission-${scenario}.png`,
    ],
    { encoding: 'utf8', timeout: 180_000, cwd: ROOT },
  )
  if (res.status !== 0) {
    console.log(`  [FAIL] render-tui(${scenario}) exited ${res.status}: ${res.stderr?.slice(0, 300)}; run bun scripts/ui/render-tui.ts --scenario ${scenario} by hand and read its error`)
    failures++
    return null
  }
  const g = JSON.parse(readFileSync(`/tmp/grid-${cols}.json`, 'utf8')) as Grid
  return g.grid.map(row => row.map(c => c.c).join(''))
}

console.log('============================================================')
console.log(' /tasks MISSION dual-list — #181 LIVESTALE')
console.log('============================================================')

console.log('\n── A. mission ledger + zero runs (120 cols) ────────────────')
missionHint = 'change the Mission and runs sections of the /tasks view in src/screen/tasks/background-tasks/views.tsx'
{
  const lines = capture('tasks-mission', 120, 40)
  if (lines) {
    const all = lines.join('\n')
    check('Mission section header paints', all.includes('Mission'))
    check('in-progress row shows the activeForm (rail grammar)', all.includes('Charting the reef current'))
    check('queued subjects paint', all.includes('Refit the tide gauges') && all.includes('Sound the harbor depth'))
    check('done roll-up paints', all.includes('1 done'))
    check('runs scope honestly empty ("no background runs")', all.includes('no background runs'))
    check('subtitle counts the mission work', all.includes('3 mission'))
    check('the old blind line is GONE', !all.includes('no tasks currently running'))
    check('the both-empty line is absent (ledger is live)', !all.includes('no mission tasks'))
  }
}

console.log('\n── B. runs only, empty ledger (80 cols) ────────────────────')
missionHint = ''
{
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const { vshotBudgetMs: S } = await import('../lib/captureDriver.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: ['after:crewmates here:1200:!sleep 300', 'after:crewmates here:2400:\r'],
    seconds: 16,
    cols: 80,
    rows: 40,
    keep: true,
  })
  try {
    const [snap] = grabScreens(run, 80, 40, [S(14500)])
    const all = snap!.rows.join('\n')
    check('the typed bang delivers (the echo row paints in the session as a shell row, "! sleep 300", never the prompt caret — F33A-B-SH-06)', all.includes('! sleep 300') && !all.includes('❯ sleep 300'), all.split('\n').filter(r => /sleep/.test(r)).join(' | ').slice(0, 200))
    check('no Mission header on an empty ledger (restraint)', !all.includes('Mission ('))
    check('EXPECTED-DEFECT: the running bang shell paints no background hint yet — its return re-pins the full journey', !all.includes('run in background'), all.split('\n').filter(r => /background/.test(r)).join(' | ').slice(0, 200))
  } finally {
    run.cleanup()
  }
}


console.log()
if (failures > 0) {
  console.log(`❌ TASKS-MISSION PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ TASKS-MISSION PROOF PASS')
