#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const DRAFT = 'Review the open pull requests and list the ones that touch the parser'

type Cell = { c: string }
type Cursor = { x: number; y: number }
type Stage = { cols: number; rows: number; grid: Cell[][]; cursor?: Cursor }
type Capture = Stage & { stages?: Stage[] }
type Popup = { top: number; left: number; rows: string[] }

const linesOf = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join(''))
const editing = (lines: string[]): boolean => lines.some(l => l.includes('new saved prompt')) && lines.some(l => l.includes(`❯ ${DRAFT}`))
const onSaved = (lines: string[]): boolean => lines.some(l => l.includes('kept per project')) && lines.some(l => l.includes('no saved prompts yet'))

function popupOf(lines: string[]): Popup | null {
  const line = (y: number): string => lines[y] ?? ''
  const title = lines.findIndex(l => l.includes('Mercury — prompts'))
  if (title < 0) return null
  const left = line(title).lastIndexOf('│', line(title).indexOf('Mercury — prompts'))
  let top = title
  while (top >= 0 && line(top)[left] !== '╭') top--
  let bottom = title
  while (bottom < lines.length && line(bottom)[left] !== '╰') bottom++
  const right = line(top).indexOf('╮', left)
  if (left < 0 || top < 0 || bottom >= lines.length || right < 0) return null
  return { top, left, rows: lines.slice(top, bottom + 1).map(l => l.slice(left, right + 1)) }
}

function journey(scenario: string, cols: number, rows: number): { status: number | null; stderr: string; capture: Capture } {
  const scratch = mkdtempSync(join(tmpdir(), 'prompts-draft-narrow-first-'))
  const gridPath = join(scratch, `grid-${cols}x${rows}.json`)
  const r = spawnSync(
    process.env.BUN ?? process.execPath,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', scenario, '--cols', String(cols), '--rows', String(rows), '--out', join(scratch, `${scenario}.png`), '--grid', gridPath],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'home') } },
  )
  let capture: Capture = { cols: 0, rows: 0, grid: [] }
  try {
    capture = JSON.parse(readFileSync(gridPath, 'utf8'))
  } catch {
  }
  rmSync(scratch, { recursive: true, force: true })
  return { status: r.status, stderr: (r.stderr ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 300), capture }
}

const t = checker()

t.section('a saved-prompt draft typed at 80x30 through 120x40 → 80x30 → 120x40 on the built bundle')
{
  const opened = journey('prompts-panel-draft-resize', 120, 40)
  const resized = journey('prompts-panel-draft-narrow-first', 80, 30)
  t.check('the wide-opened capture ran (render-tui exit 0)', opened.status === 0, `exit=${opened.status} ${opened.stderr}`)
  t.check('the narrow-first journey ran (render-tui exit 0)', resized.status === 0, `exit=${resized.status} ${resized.stderr}`)
  const wide = opened.capture.stages?.[0]
  const stages = resized.capture.stages ?? []
  const final = linesOf(resized.capture.grid)
  const wideLines = wide === undefined ? [] : linesOf(wide.grid)
  t.check(
    'the window went 80x30 → 120x40 → 80x30 → 120x40',
    stages.map(s => `${s.cols}x${s.rows}`).join(' ') === '80x30 120x40 80x30' && resized.capture.cols === 120 && resized.capture.rows === 40,
    `${stages.map(s => `${s.cols}x${s.rows}`).join(' → ')} → ${resized.capture.cols}x${resized.capture.rows}`,
  )
  t.check('at 80x30, before the widening, the new saved prompt editor held the draft', stages[0] !== undefined && editing(linesOf(stages[0].grid)))
  t.check('opened at 120x40, the new saved prompt editor holds the draft', wide !== undefined && wide.cols === 120 && wide.rows === 40 && editing(wideLines))
  t.check('back at 120x40, the new saved prompt editor is still open and holds the draft', editing(final))
  t.check('back at 120x40, the panel is still on SAVED PROMPTS', onSaved(final))
  const here = popupOf(final)
  const there = popupOf(wideLines)
  t.check(
    'back at 120x40, the pop-up is drawn where and as /workbench opened at 120x40 draws it',
    here !== null && there !== null && JSON.stringify(here) === JSON.stringify(there),
    `pop-up box at ${here === null ? 'none' : `row ${here.top} col ${here.left}, ${here.rows.length} rows`}, opened wide at ${there === null ? 'none' : `row ${there.top} col ${there.left}, ${there.rows.length} rows`}; the pop-up's claim in src/screen/cockpit/commandPopup.ts decides its host in src/screen/fullscreen-layout/FullscreenLayout.tsx`,
  )
  t.check(
    'back at 120x40, the caret sits where it sits in the pop-up opened at 120x40',
    wide?.cursor !== undefined && resized.capture.cursor?.x === wide.cursor.x && resized.capture.cursor.y === wide.cursor.y,
    `cursor ${JSON.stringify(resized.capture.cursor ?? null)} · opened wide ${JSON.stringify(wide?.cursor ?? null)}`,
  )
}

t.finish('prove-draft-survives-narrow-first')
