#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-chip-atomicity — F3 on the BUILT artifact.
//
//  Reproduced pre-fix: the chip-atomicity machinery (cursor hop · inside-
//  snap · invert-select · whole-chip backspace) filtered for [Image #N]
//  ONLY — a [Pasted text #N] chip could be entered char-by-char and
//  corrupted, and the broken ref silently dropped its pasted content at
//  submit. Orphaned text pastes also never pruned.
//
//  The law proven here (real PTY, bracketed paste):
//    · ← from after a text chip lands AT the chip start (never inside):
//      a typed char inserts BEFORE the intact chip;
//    · → from chip start hops the whole chip; ⌫ at chip end deletes the
//      ENTIRE chip in one stroke (backspace = left().modifyText — the hop
//      IS the atomicity).
// ============================================================================
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
const t = (name: string, ok: boolean, detail = ''): void => {
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
  // Fresh fixture per capture — writeSyntheticSession purges the session's
  // draft, so capture A's composer can never restore into capture B's boot.
  writeSyntheticSession('short', SID)
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, cols: 120, rows: 40, out }))
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

const prefix = [
  { atTick: 40, data: 'hi ', minTick: 30 },
  { atTick: 44, data: PASTE, afterPrevTicks: 3 },
]

try {
  // A: ← then type X — the cursor must be AT chip start, so X inserts
  // BEFORE the intact chip (pre-fix: X corrupted the chip body).
  const a = capture('a', [
    ...prefix,
    { atTick: 50, data: LEFT, afterPrevTicks: 4 },
    { atTick: 53, data: 'X', afterPrevTicks: 2 },
  ], 68)
  t('← hops to chip start: typed X lands BEFORE the intact chip',
    /hi X\[Pasted text #1 \+5 lines\]/.test(a), `composer="${a.trim().slice(0, 70)}"`)

  // B: continue — → hops the whole chip, ⌫ at chip end deletes it whole.
  const b = capture('b', [
    ...prefix,
    { atTick: 50, data: LEFT, afterPrevTicks: 4 },
    { atTick: 53, data: 'X', afterPrevTicks: 2 },
    { atTick: 56, data: RIGHT, afterPrevTicks: 2 },
    { atTick: 59, data: BKSP, afterPrevTicks: 2 },
  ], 76)
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
