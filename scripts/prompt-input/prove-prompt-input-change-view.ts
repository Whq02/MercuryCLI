#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-change-view — F2 on the BUILT artifact.
//
//  Before: Structure preview/apply results rendered as 12 plain truncated
//  text lines (no hunks, no file headers, no expansion affordance beyond raw
//  text). Now semantic-edit results ride the ONE premium inline change view:
//
//    · collapsed — one honest line: state word (proposed = amber family) ·
//      file/match counts · +A/−R totals · the ctrl+o hint;
//    · expanded — per-file railed `diff · <basename>` cards (the SAME
//      StructuredDiffList the Edit tool renders: syntax-aware, gutter line
//      numbers), the diagnostics line, and the resolvable mercury:// ref.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-cv-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][] }
const textOf = (g: Grid): string => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function capture(name: string, cols: number): string {
  const cfg = scenario(name, cols, 40)
  const out = join(home, `${name}-${cols}.json`)
  const cfgPath = join(home, `${name}-${cols}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends: cfg.sends ?? [], total: cfg.total ?? 45, cols, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${name} failed: ${res.stderr?.slice(-500)}`)
  return textOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

try {
  // Collapsed: the one-line decidable summary, no diff body.
  const collapsed = capture('structure-card', 120)
  t('collapsed: state word + counts on one line', collapsed.includes('replace proposed') && collapsed.includes('2 files') && collapsed.includes('2 matches'))
  t('collapsed: honest ± totals', collapsed.includes('+2/−2'))
  t('collapsed: expansion affordance named', collapsed.includes('ctrl+o expands'))
  t('collapsed: no diff body painted', !collapsed.includes('greetOperator(name)'))

  // Expanded at 120: railed per-file diff cards + diagnostics + refs.
  const detail = capture('structure-card-detail', 120)
  t('expanded: per-file railed diff card (greet.ts)', detail.includes('diff · greet.ts'))
  t('expanded: second file card (cli.ts)', detail.includes('diff · cli.ts'))
  t('expanded: hunk body with the replacement visible', detail.includes('greetOperator(name)'))
  t('expanded: gutter line numbers render', /\b4 {2}export function greet|4 {1,3}export/.test(detail))
  t('expanded: diagnostics line', detail.includes('diagnostics planned: 2 files'))
  t('expanded: resolvable record ref', detail.includes('mercury://structure/preview/sp-fixture01'))

  // Expanded at 80: the frameless fallback keeps the hierarchy.
  const narrow = capture('structure-card-detail', 80)
  t('80-col: file header + hunk survive', narrow.includes('src/greet.ts') && narrow.includes('greetOperator(name)'))
  t('80-col: ref line survives', narrow.includes('mercury://structure/preview/sp-fixture01'))
} finally {
  cleanupScenario('structure-card')
}

console.log(failures === 0 ? '✅ kinetic change-view law holds' : '❌ kinetic change-view BROKEN')
process.exit(failures)
