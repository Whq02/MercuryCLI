#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-chip-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario, writeSyntheticSession, SID } = await import('../ui/renderScenarios.ts')
const cfg = scenario('resume-2turn', 120, 40)

let failures = 0
const t = (name: string, ok: boolean, detail = 'change the chip hop on left and right and the whole-chip backspace in src/screen/composer/vim/textCursor.ts (chipEndingAt, chipStartingAt) so a pasted chip moves and deletes as one unit'): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][] }
const rowsOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const composerOf = (rows: string[]): string => {
  const idx = rows.map((r, i) => (r.includes('│❯') ? i : -1)).filter(i => i >= 0)
  return idx.length ? rows[idx[idx.length - 1]]! : ''
}

function capture(tag: string, sends: unknown[], total: number): string {
  writeSyntheticSession('short', SID)
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, stableTicks: 4, cols: 120, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${res.stderr?.slice(-500)}`)
  return composerOf(rowsOf(JSON.parse(readFileSync(out, 'utf8')) as Grid))
}

const ESC = '\u001b'
const PASTE = `${ESC}[200~alpha\nbeta\ngamma\ndelta\nepsilon\nzeta${ESC}[201~`
const LEFT = `${ESC}[D`
const RIGHT = `${ESC}[C`
const BKSP = '\u007f'

const CHIP = '[Pasted text #1 +5 lines]'
const prefix = [
  { requireAwait: true, awaitText: '│❯', minTick: 5, awaitStableTicks: 5, data: 'hi ' },
  { requireAwait: true, awaitText: '│❯', awaitPattern: '│❯\\s*hi\\b', data: PASTE },
  { requireAwait: true, awaitText: CHIP, data: LEFT },
  { afterPrevTicks: 2, data: 'X' },
]

try {
  const a = capture('a', [
    ...prefix,
    { requireAwait: true, awaitText: `hi X${CHIP}`, data: '' },
  ], 200)
  t('← hops to chip start: typed X lands BEFORE the intact chip',
    /hi X\[Pasted text #1 \+5 lines\]/.test(a), `composer="${a.trim().slice(0, 70)}"`)

  const b = capture('b', [
    ...prefix,
    { requireAwait: true, awaitText: `hi X${CHIP}`, data: RIGHT },
    { afterPrevTicks: 2, data: BKSP },
    { requireAwait: true, awaitText: 'hi X', awaitPattern: '\\A(?![\\s\\S]*Pasted)', data: '' },
  ], 200)
  t('→ hops the chip; ⌫ at chip end deletes the WHOLE chip',
    b.includes('hi X') && !b.includes('[Pasted'),
    `composer="${b.trim().slice(0, 70)}"`)
  t('no partial-chip residue after the atomic delete',
    !b.includes('lines]') && !b.includes('Pasted'),
    `composer="${b.trim().slice(0, 70)}"`)
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ kinetic chip-atomicity law holds' : '❌ kinetic chip-atomicity BROKEN')
process.exit(failures)
