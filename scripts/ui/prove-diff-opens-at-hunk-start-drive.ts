#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const SCENARIO = 'diff-open-long-hunk'
const KEEP = process.argv.includes('--keep')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-diff-hunk-start-drive-')))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(join(REPO, 'dist', 'mercury.mjs'))) {
  console.error('prove-diff-opens-at-hunk-start-drive: dist/mercury.mjs missing — run `bun run build.ts` first')
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(1)
}

type Cell = { c?: string }
type Mark = { label: string; grid: Cell[][] }
type Capture = { status: number; stderr: string; rows: string[]; at: (label: string) => string[] }

const rowsOf = (grid: Cell[][]): string[] => grid.map(row => row.map(cell => (cell.c === undefined || cell.c === '' ? ' ' : cell.c)).join(''))

function capture(cols: number, rows: number): Capture {
  const gridPath = join(SCRATCH, `grid-${cols}x${rows}.json`)
  const res = spawnSync(
    process.execPath,
    ['run', join(REPO, 'scripts', 'ui', 'render-tui.ts'), '--scenario', SCENARIO, '--cols', String(cols), '--rows', String(rows), '--out', join(SCRATCH, `${cols}x${rows}.png`), '--grid', gridPath],
    { encoding: 'utf8', cwd: REPO, timeout: vshotBudgetMs(240_000) },
  )
  let payload: { grid?: Cell[][]; marks?: Mark[] } = {}
  try {
    payload = JSON.parse(readFileSync(gridPath, 'utf8'))
  } catch (error) {
    console.log(`  the grid ${gridPath} could not be read: ${String(error)}`)
  }
  return {
    status: res.status ?? 1,
    stderr: `${res.stderr ?? ''}${res.error ? ` ${String(res.error)}` : ''}`.trim(),
    rows: rowsOf(payload.grid ?? []),
    at: label => rowsOf(payload.marks?.find(mark => mark.label === label)?.grid ?? []),
  }
}

function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const row of rows) console.log(`│${row.replace(/\s+$/, '')}`)
  console.log('└──')
}

const firstLinesOf = (fn: string, local: string, sign: string): RegExp[] => [
  new RegExp(`(^|\\s)1 def ${fn}0\\(x\\):`),
  new RegExp(`\\sreturn x \\${sign} 0(?!\\d)`),
  new RegExp(`\\sreturn ${local} \\${sign} 0(?!\\d)`),
]
const BIG = firstLinesOf('f', 'y', '+')
const NEXT = firstLinesOf('g', 'z', '-')
const startsAt = (rows: string[], lines: RegExp[]): boolean => lines.every(line => rows.some(row => line.test(row)))
const RAILS = ['WORKBENCH', 'VITALS']
const WHERE = 'line 1 of the file and its change are not on screen, so the diff stands further down its hunk than its start. The /diff body is the scroll box of CommandCenter in src/screen/widgets/components.tsx: the pop-up passes bodyRestsAtTop (src/screen/diff/diff-dialog/views.tsx), DiffDialog sends the body to its top for each file and hunk it shows (src/screen/diff/DiffDialog.tsx), and a box that rests at its top stops counting as at its end when it is sent somewhere (scrollTo in src/screen/renderer/elements/ScrollBox.tsx)'

console.log('prove-diff-opens-at-hunk-start-drive: the built product over a scratch repo whose big.py and next.py each have one long hunk (300 functions changed); /diff, ↵ on big.py, end, ] to next.py, end, ← to the list, ↑, ↵ on big.py: every opening must show the hunk from its first lines')

for (const size of [{ cols: 120, rows: 40, rails: true }, { cols: 80, rows: 24, rails: false }]) {
  const tag = `${size.cols}x${size.rows}`
  const run = capture(size.cols, size.rows)
  const opened = run.at('opened')
  const stepped = run.at('stepped')
  printFrame(`${tag} big.py opened`, opened)
  printFrame(`${tag} next.py stepped to`, stepped)
  printFrame(`${tag} big.py opened again`, run.rows)
  check(`${tag}: the capture ran to its settled end`, run.status === 0 && run.rows.length === size.rows, `render-tui exit ${run.status} · ${run.stderr.slice(-600)} · run bun scripts/ui/render-tui.ts --scenario ${SCENARIO} --cols ${size.cols} --rows ${size.rows} by hand and read its error; rebuild dist/mercury.mjs with bun run build.ts if the bundle is stale`)
  if (run.rows.length !== size.rows) continue
  const railsShown = RAILS.every(word => run.rows.some(row => row.startsWith(word)))
  const railsGone = RAILS.every(word => !run.rows.some(row => row.includes(word)))
  check(
    size.rails ? `${tag}: the session stands in the layout with the left rails (${RAILS.join(', ')})` : `${tag}: the session stands in the full-screen layout, no rails`,
    size.rails ? railsShown : railsGone,
    `the rails at ${tag} are ${railsShown ? 'on screen' : 'not on screen'}; read the printed frame above`,
  )
  check(
    `${tag}: /diff listed big.py and ↵ was pressed on it`,
    run.at('list').some(row => /❯ big\.py/.test(row)) && run.at('list').some(row => row.includes('↵ view')),
    'the frame at the ↵ shows no /diff list with big.py selected: the scenario diff-open-long-hunk in scripts/ui/renderScenarios.ts must reach the list of src/screen/diff/DiffFileList.tsx',
  )
  check(`${tag}: ↵ on big.py opens its diff at the hunk's first lines`, startsAt(opened, BIG), WHERE)
  check(`${tag}: ] from the end of big.py opens next.py at the hunk's first lines`, startsAt(stepped, NEXT), WHERE)
  check(`${tag}: with both read to their ends, ← and ↵ on big.py open it at the hunk's first lines again`, startsAt(run.rows, BIG), WHERE)
}

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-diff-opens-at-hunk-start-drive: ALL LAWS HOLD' : `prove-diff-opens-at-hunk-start-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
