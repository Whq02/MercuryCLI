#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' workflow inline renderers — real-binary render regression guard')
console.log('============================================================')

const cols = 100
const rows = 40
const gridPath = `/tmp/grid-wf-inline.json`
const cfgPath = `/tmp/vshot-wf-inline.json`

const captureOnce = async (): Promise<string> => {
  const cfg = { ...scenario('workflow-inline', cols, rows), out: gridPath }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(120000),
    env: { ...process.env },
  })
  if (res.status !== 0) {
    console.log('  vshot failed:', (res.stderr || '').slice(0, 300))
    return ''
  }
  const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid?: Array<Array<{ c?: string }>>
  }
  return Array.isArray(parsed.grid)
    ? parsed.grid.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n')
    : ''
}

const painted = (t: string): boolean =>
  /Workflow/.test(t) && /greet then read/.test(t) && /\/workflows/.test(t)

let text = ''
try {
  text = await captureOnce()
  if (!painted(text)) {
    console.log('  (first capture incomplete — one retry)')
    text = await captureOnce()
  }
} finally {
  cleanupScenario('workflow-inline')
}

const nonblank = text.replace(/\s/g, '').length > 0
check('capture is non-blank (renderer did not regress to null/blank)', nonblank)
check('tool-use line shows the Workflow name + description', /Workflow/.test(text) && /greet then read/.test(text), firstMatch(text, /Workflow.*/))
check('result line paints (live renderer mounted, honest missing-task branch)',
  /\/workflows/.test(text) && /to view dynamic workflow runs/.test(text), firstMatch(text, /\/workflows.*/))

function firstMatch(s: string, re: RegExp): string {
  const m = s.match(re)
  return m ? m[0].trim().slice(0, 70) : ''
}

console.log('')
if (failures > 0) {
  console.log(`RESULT: RED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: GREEN — inline Workflow renderers paint in the real binary')
