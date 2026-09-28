#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')

type Cell = { c: string }
type Grid = { cols: number; rows: number; grid: Cell[][] }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function render(scenario: string): { grid: Grid | null; error: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'rail-recent-lane-'))
  const gridPath = join(scratch, 'grid.json')
  const r = spawnSync(
    BUN,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', scenario, '--cols', '120', '--rows', '44', '--grid', gridPath, '--out', join(scratch, 'out.png')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_LIVE_GLYPHS: '0', MERCURY_CRITTER: 'crab' }, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0 || !existsSync(gridPath)) {
    rmSync(scratch, { recursive: true, force: true })
    return { grid: null, error: `${(r.stdout ?? '').slice(-300)}${(r.stderr ?? '').slice(-300)}`.replace(/\n/g, ' ') }
  }
  const grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
  rmSync(scratch, { recursive: true, force: true })
  return { grid, error: '' }
}

function railLines(g: Grid): string[] {
  return g.grid.map(row => {
    const text = row.map(c => c.c).join('')
    const cut = text.indexOf('│')
    return (cut >= 0 ? text.slice(0, cut) : text).trimEnd()
  })
}

const isHeader = (line: string): boolean => /^[A-Z]/.test(line)
const railHeaders = (lines: string[]): string[] => lines.filter(isHeader).map(l => l.split(' · ')[0]!.trim())
function recentRows(lines: string[]): string[] {
  const rows: string[] = []
  let inside = false
  for (const line of lines) {
    if (isHeader(line)) inside = line.startsWith('RECENT')
    else if (inside && line.trim() !== '') rows.push(line.trim())
  }
  return rows
}

console.log('='.repeat(60))
console.log(' the lanes rail RECENT lane — never the open conversation; the same rail after a resize journey')
console.log('='.repeat(60))

const direct = render('resume-2turn')
check('direct 120x44 --resume boot rendered', direct.grid !== null, direct.error)
const journey = render('resize-return')
check('resize-return journey (120→80→45→150→120) rendered', journey.grid !== null, journey.error)

if (direct.grid !== null && journey.grid !== null) {
  const directRail = railLines(direct.grid)
  const journeyRail = railLines(journey.grid)
  const directRecent = recentRows(directRail)
  check(
    'R5 the RECENT lane of a direct --resume boot never lists the conversation open in the VIEW (the resumed session)',
    !directRecent.some(row => row.includes('first task')),
    `direct RECENT rows ${JSON.stringify(directRecent)}`,
  )
  check(
    'R6 the lanes rail carries the same sections after the journey as a direct boot at the same size',
    JSON.stringify(railHeaders(directRail)) === JSON.stringify(railHeaders(journeyRail)),
    `direct ${JSON.stringify(railHeaders(directRail))} vs journey ${JSON.stringify(railHeaders(journeyRail))}`,
  )
}

console.log()
if (failures > 0) {
  console.log(`❌ ${failures} RAIL RECENT-LANE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RAIL RECENT-LANE PROOFS PASS')
