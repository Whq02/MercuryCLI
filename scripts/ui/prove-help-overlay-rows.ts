#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const helpRowsHint = 'the rows of the ? overlay are built in PromptInputHelpMenu in src/screen/composer/ComposerHelpMenu.tsx: fix the row text or its column layout and clipping there'

function capture(cols: number, rows: number): string[] | null {
  const cfg = scenario('help', cols, rows)
  const gridPath = `/tmp/help-rows-${cols}x${rows}-${process.pid}.json`
  const cfgPath = `/tmp/help-rows-cfg-${cols}x${rows}-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(180_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'help-overlay-home-')),
    },
  })
  cleanupScenario('help')
  if (res.status !== 0) {
    check(`${cols}x${rows}: PTY capture ran`, false, `${res.stderr?.slice(0, 200) ?? ''} scripts/ui/vshot.py exited nonzero for the help scenario in scripts/ui/renderScenarios.ts: run it by hand and read its stderr`)
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
  return grid.map(r => r.map(c => c.c).join(''))
}

const GLOBAL_ROWS = [
  'for command palette',
  'to open a file',
  'to search contents',
  'to switch session',
  'to undo',
  'to redo',
  'to suspend',
  'to paste images',
  'to switch model',
  'to stash prompt',
  'to edit in $EDITOR',
]
const MERGE_SIGNATURES = ['suspendo', 'undoo', 'redoo', 'stasho']

function countLines(lines: string[], needle: string): number {
  return lines.filter(l => l.includes(needle)).length
}

console.log('============================================================')
console.log(" '?' overlay rows — whole, exactly once, at canonical sizes")
console.log('============================================================')

{
  const g = capture(120, 40)
  if (g) {
    for (const needle of GLOBAL_ROWS) {
      const n = countLines(g, needle)
      check(`120x40: "${needle}" exactly once`, n === 1, `count=${n} ${helpRowsHint}`)
    }
    for (const sig of MERGE_SIGNATURES) {
      check(`120x40: no merge residue "${sig}"`, countLines(g, sig) === 0, `${helpRowsHint}; two rows are running together in one line`)
    }
    const undoLine = g.find(l => l.includes('to undo') && !l.includes('undoo'))
    check('120x40: the undo row ends clean', !!undoLine && undoLine.trimEnd().endsWith('to undo'),
      `${JSON.stringify(undoLine?.trimEnd().slice(-40))} ${helpRowsHint}`)
  }
}

{
  const g = capture(150, 45)
  if (g) {
    const missing = GLOBAL_ROWS.filter(n => countLines(g, n) !== 1)
    check('150x45: every global row exactly once', missing.length === 0, `${missing.join(' | ')} ${helpRowsHint}`)
    check('150x45: no merge residue', MERGE_SIGNATURES.every(s => countLines(g, s) === 0), `${helpRowsHint}; two rows are running together in one line`)
  }
}

{
  const g = capture(80, 24)
  if (g) {
    check('80x24: no merge residue', MERGE_SIGNATURES.every(s => countLines(g, s) === 0), `${helpRowsHint}; two rows are running together in one line`)
    const seen: number[] = []
    for (let i = 0; i < GLOBAL_ROWS.length; i++) {
      const idx = g.findIndex(l => l.includes(GLOBAL_ROWS[i]!))
      const n = countLines(g, GLOBAL_ROWS[i]!)
      check(`80x24: "${GLOBAL_ROWS[i]}" at most once`, n <= 1, `count=${n} ${helpRowsHint}`)
      if (idx >= 0) seen.push(idx)
    }
    const ordered = seen.every((v, i) => i === 0 || v > seen[i - 1]!)
    check('80x24: rendered rows preserve source order (tail clip only)', ordered, `${seen.join(',')} ${helpRowsHint}`)
  }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
