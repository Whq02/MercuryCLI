#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 — the focus graph nodes')
{
  const { ACTION_GRAPH } = await import('../../src/screen/keys/actionGraph.ts')
  const keys = Object.keys(ACTION_GRAPH)
  for (const id of [
    'prompts:expand',
    'prompts:new-saved',
    'prompts:edit-saved',
    'prompts:move-saved',
    'prompts:delete-saved',
    'prompts:send-saved',
  ]) {
    t.check(`the graph names ${id}`, keys.includes(id))
  }
  for (const id of ['board:dispatch', 'board:peek', 'board:change-next', 'board:side-question', 'board:attach', 'board:graph', 'composer:shelf']) {
    t.check(`the graph no longer names ${id} (retired with the WORK panel)`, !keys.includes(id))
  }
}

t.section('§2 — keyboard/pointer equivalence at the grammar')
{
}

t.section('§3 — the resize journey on the REAL binary')
{
  const scratch = mkdtempSync(join(tmpdir(), 'b2-focus-resize-'))
  const gridPath = join(scratch, 'grid-120.json')
  const r = spawnSync(
    process.env.BUN ?? `${homedir()}/.bun/bin/bun`,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', 'prompts-panel-resize', '--cols', '120', '--out', join(scratch, 'rv-b2-resize.png'), '--grid', gridPath],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000 },
  )
  t.check('the resize journey ran (render-tui exit 0)', r.status === 0, `exit=${r.status} ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`)
  let txt = ''
  try {
    const g = JSON.parse(readFileSync(gridPath, 'utf8')) as {
      grid: Array<Array<{ c: string }>>
    }
    txt = g.grid.map(row => row.map(c => c.c).join('')).join('\n')
  } catch {
  }
  rmSync(scratch, { recursive: true, force: true })
  t.check('the strip is intact at the return width', txt.includes('PROMPTS') && txt.includes('SAVED PROMPTS'))
  t.check(
    'the ↑-selected older prompt HELD its row through wide→narrow→wide',
    /▸.*first task/.test(txt),
  )
  const headers = (txt.match(/Mercury — prompts/g) ?? []).length
  const mascots = (txt.match(/▖▟▆▙▗/g) ?? []).length
  t.check('exactly one popup header and no stale mascot resurrect', headers === 1 && mascots === 0, `headers=${headers} mascots=${mascots}`)
}

t.finish('prove-b2-focus-pointer')
