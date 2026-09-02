#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function capture(name: string, cols: number, rows: number): { final: string; atSend: string } {
  const gridPath = `/tmp/grid-${name}.json`
  const cfgPath = `/tmp/vshot-${name}.json`
  const cfg = { ...scenario(name, cols, rows), out: gridPath }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(180000),
    env: { ...process.env },
  })
  if (res.status !== 0) {
    throw new Error(`vshot failed for ${name}: ${res.stdout}\n${res.stderr}`)
  }
  const parsed = JSON.parse(readFileSync(gridPath, 'utf-8')) as {
    grid?: Array<Array<{ c?: string }>>
    marks?: Array<{ label: string; grid: Array<Array<{ c?: string }>> }>
  }
  const text = (g: Array<Array<{ c?: string }>> | undefined): string =>
    Array.isArray(g) ? g.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n') : ''
  return {
    final: text(parsed.grid),
    atSend: text(parsed.marks?.find(m => m.label === 'atlas-open')?.grid),
  }
}

console.log('input atlas — advertised Escape closes it')

for (const cols of [80, 120]) {
  console.log(`\n— keys-escape @${cols} —`)
  const { final, atSend } = capture('keys-escape', cols, 44)
  check(
    `@${cols}: the atlas was OPEN when the ESC was sent (no vacuous pass)`,
    /input atlas/.test(atSend),
    'the atlas never opened — this capture proves nothing about Escape',
  )
  check(
    `@${cols}: the atlas is GONE after Escape`,
    !/input atlas/.test(final),
    'the final frame still shows the atlas — Escape is dead in browse mode',
  )
  check(`@${cols}: the session view is back`, /for commands/.test(final))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
