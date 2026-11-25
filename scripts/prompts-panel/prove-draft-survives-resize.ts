#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const DRAFT = 'Review the open pull requests and list the ones that touch the parser'

type Cell = { c: string }
type Stage = { cols: number; rows: number; grid: Cell[][] }
type Capture = { cols: number; rows: number; grid: Cell[][]; cursor?: { x: number; y: number }; stages?: Stage[] }

const linesOf = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join(''))
const editing = (lines: string[]): boolean => lines.some(l => l.includes('new saved prompt')) && lines.some(l => l.includes(`❯ ${DRAFT}`))

const t = checker()

t.section('a saved-prompt draft through wide → narrow → wide on the built bundle')
{
  const scratch = mkdtempSync(join(tmpdir(), 'prompts-draft-resize-'))
  const gridPath = join(scratch, 'grid-120x40.json')
  const r = spawnSync(
    process.env.BUN ?? process.execPath,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', 'prompts-panel-draft-resize', '--cols', '120', '--rows', '40', '--out', join(scratch, 'draft-resize.png'), '--grid', gridPath],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'home') } },
  )
  t.check('the journey ran (render-tui exit 0)', r.status === 0, `exit=${r.status} ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`)
  let capture: Capture = { cols: 0, rows: 0, grid: [] }
  try {
    capture = JSON.parse(readFileSync(gridPath, 'utf8'))
  } catch {
  }
  rmSync(scratch, { recursive: true, force: true })
  const stages = capture.stages ?? []
  const [wide, narrow] = stages
  const final = linesOf(capture.grid)
  const draftRow = final.findIndex(l => l.includes(`❯ ${DRAFT}`))
  t.check(
    'the window went 120x40 → 80x30 → 120x40',
    stages.length === 2 && wide?.cols === 120 && wide.rows === 40 && narrow?.cols === 80 && narrow.rows === 30 && capture.cols === 120 && capture.rows === 40,
    `${stages.map(s => `${s.cols}x${s.rows}`).join(' → ')} → ${capture.cols}x${capture.rows}`,
  )
  t.check('before the narrowing, the new saved prompt editor held the draft', wide !== undefined && editing(linesOf(wide.grid)))
  t.check(
    'back at 120x40, the new saved prompt editor is still open and holds the draft',
    editing(final),
    'the draft was lost when the panel moved into the full-pane layout; the editor state lives in src/screen/prompts-panel/PromptsPanel.tsx',
  )
  t.check(
    'back at 120x40, the caret is still after the last typed character',
    draftRow >= 0 && capture.cursor?.y === draftRow && capture.cursor.x === final[draftRow].indexOf(DRAFT) + DRAFT.length,
    `cursor ${JSON.stringify(capture.cursor ?? null)} · draft row ${draftRow}`,
  )
  t.check('back at 120x40, the panel is still on SAVED PROMPTS', final.some(l => l.includes('▸ 3 SAVED PROMPTS')) && final.some(l => l.includes('kept per project')))
}

t.finish('prove-draft-survives-resize')
