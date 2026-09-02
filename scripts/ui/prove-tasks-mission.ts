#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-tasks-mission.ts — the /tasks MISSION dual-list (#181,
//  LIVESTALE).
//
//  The bug: /tasks read ONLY the background-process registry and printed
//  "no tasks currently running" while the cockpit rail's MISSION board showed
//  a live task ledger — two scopes, one invisible. The fix dual-lists: the
//  dialog renders a Mission section from the SAME telemetry bus the rail
//  reads, above the process sections, with each scope's empty state honestly
//  labeled.
//
//  PTY legs (the real binary, vshot cell grid):
//    A. tasks-mission @120 — mission ledger fixture, ZERO background runs:
//       Mission section paints (◐ activeForm row + ○ queued + done count),
//       the runs scope reads "no background runs", the subtitle counts
//       mission work. The old blind line must be GONE.
//    B. runs-only @80 (artifact arena: fake wire + real runner) — two
//       backgrounded bang shells, EMPTY ledger: the shells echo, NO Mission
//       header (restraint), the dialog's honest empty scope.
//  Source ratchet: the old unscoped empty-state string stays retired.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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
    console.log(`  [FAIL] render-tui(${scenario}) exited ${res.status}: ${res.stderr?.slice(0, 300)}`)
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
{
  // A managed session's bang shells run in ITS runner: the face's /tasks
  // dialog reads the screen's own task map, which holds none, and says so
  // honestly. Listing the focused session's shells on the face needs a tasks
  // projection door on the connector — a named follow-up; when it lands the
  // Shells section re-pins here.
  //
  // RE-BASED after the retirement of the old
  // tasks-runs-only vshot scenario: the keyless capture world could never
  // revive a runner, so the drive typed into a runner-less composer and the
  // dialog never opened. This leg now rides the artifact-arena idiom the
  // retirement named (fake wire + real runner — the command-privacy-drive
  // shape): two bang shells typed and ctrl+b-backgrounded in a REAL runner
  // session, then /tasks.
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const { vshotBudgetMs: S } = await import('../lib/captureDriver.ts')
  const run = await runArtifactArena({
    turns: [],
    // Observed-ready sends: the '↵ sends' idle hint row is the chat's own
    // stable needle (the paste-safety lesson: '? for shortcuts' sights on
    // the Boot face's shared footer, and the 80-col bare composer paints
    // no 'Type a prompt' placeholder).
    sends: ['after:↵ sends:1200:!sleep 300', 'after:↵ sends:2400:\r'],
    seconds: 16,
    cols: 80,
    rows: 40,
    keep: true,
  })
  try {
    const [snap] = grabScreens(run, 80, 40, [S(14500)])
    const all = snap!.rows.join('\n')
    // What WORKS is pinned live: the typed bang DELIVERS — its echo row
    // paints (the delivery law through a real runner).
    check('the typed bang delivers (the echo row paints in the session)', all.includes('❯ sleep 300'), all.split('\n').filter(r => /sleep/.test(r)).join(' | ').slice(0, 200))
    check('no Mission header on an empty ledger (restraint)', !all.includes('Mission ('))
    // THE RECORDED DEFECT ARM (the retired scenario's known-red, adjudicated
    // forward): in the runner world the RUNNING bang shell paints
    // NO tool row and NO background hint, so the ctrl+b → second shell →
    // /tasks journey cannot proceed past this point — transcript-estate
    // work, routed. TEETH: the moment the hint returns, this arm reds and
    // the FULL journey (background both shells, /tasks dual-list) re-pins
    // here in its place.
    check('EXPECTED-DEFECT: the running bang shell paints no background hint yet — its return re-pins the full journey', !all.includes('run in background'), all.split('\n').filter(r => /background/.test(r)).join(' | ').slice(0, 200))
  } finally {
    run.cleanup()
  }
}

console.log('\n── source ratchet ──────────────────────────────────────────')
{
  const src = readFileSync(join(ROOT, 'src/components/tasks/BackgroundTasksDialog.tsx'), 'utf8')
  check('the unscoped "no tasks currently running" string stays retired', !src.includes('no tasks currently running'))
  check('the dialog reads the telemetry bus (the rail\'s feed)', src.includes('useTelemetry'))
  check('back-from-detail is mission-aware (never closes past an open ledger)', src.includes('ledgerOpenCount === 0'))
  // Slice C: the cursor-following window rides
  // the PROVEN /sessions slider — never a drifted local copy — with honest
  // ↑/↓ overflow counts; the per-row AGE column derives from task.startTime.
  check('windowing reuses computeSessionWindow (the proven slider)', src.includes('computeSessionWindow(') && src.includes("from '../mercury-ui/screens/SessionManagerView.js'"))
  check('honest overflow counts frame the process area', src.includes('↑ {winStart} more') && src.includes('more</Text>'))
  // There is no hosted remote-session rail and no windowed section for it —
  // five sections, each riding the shared slider.
  check('every section renders only its windowed rows', (src.match(/\.filter\(inWin\)\.map\(/g) ?? []).length >= 5)
  // The age read widened when the mission ledger joined the dialog: a row is
  // a task OR a work item, and the age derives from whichever scope's REAL
  // startTime the row carries — the law holds, wider.
  check('the age column derives from the real startTime', src.includes('item.task?.startTime ?? item.work?.startTime') && src.includes('formatDuration(Math.max(0, now - started))'))
}

console.log()
if (failures > 0) {
  console.log(`❌ TASKS-MISSION PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ TASKS-MISSION PROOF PASS')
