#!/usr/bin/env bun
// prove-render-oracle.ts — locks the capture oracle (renderOracle.ts) + the
// MERCURY_CONFIG_DIR-aware session staging (renderScenarios.ts). The regression
// this prevents: a boot-error screen ("No conversation found …") paints > 40
// cells, so the old blank-guard-only oracle passed it as a green render — the
// verify-by-rendering floor silently verifying nothing.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { evaluateCapture, type CapturedGrid } from './renderOracle.ts'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// Build a synthetic capture grid from text rows (pads to cols×rows with spaces).
function grid(lines: string[], cols = 80, rows = 24): CapturedGrid {
  return {
    cols, rows,
    grid: Array.from({ length: rows }, (_, y) => {
      const line = lines[y] ?? ''
      return Array.from({ length: cols }, (_, x) => ({ c: line[x] ?? ' ' }))
    }),
  }
}

// 1) Blank / partial capture rejected (the original blank-guard, preserved).
const blank = evaluateCapture(grid(['❯ hi']))
t('near-blank capture rejected', !blank.ok && blank.reason.includes('blank'), blank.reason)

// 2) THE regression case: a boot-error screen paints plenty of cells but must fail.
const err = evaluateCapture(grid([
  `No conversation found with session ID: 00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`,
  'run with --resume <id> or --continue to pick the latest conversation instead',
]))
t('boot-error screen rejected despite painted>=40', !err.ok && err.reason.includes('boot-error'), err.reason)

// 3) A wall of text with no Mercury chrome is not a trustworthy TUI capture.
const noChrome = evaluateCapture(grid([
  'the quick brown fox jumps over the lazy dog and keeps on running far away',
  'another line of plain output text that is definitely not the hermes chrome',
]))
t('chrome-less capture rejected', !noChrome.ok && noChrome.reason.includes('chrome'), noChrome.reason)

// 4) A healthy capture (frame glyphs + prompt caret) passes.
const good = evaluateCapture(grid([
  '╭──────────────────────────────────────────╮',
  '│  MERCURY                                 │',
  '│  first task                              │',
  '╰──────────────────────────────────────────╯',
  '❯ ',
]))
t('healthy capture accepted', good.ok, good.reason)

// 5) Staging honors MERCURY_CONFIG_DIR: a subprocess with a divergent config dir
// must stage the synthetic session under <dir>/projects/… (the live-Hermes
// condition — sessions run with MERCURY_CONFIG_DIR=~/.mercury).
const tmp = mkdtempSync(join(tmpdir(), 'hermes-oracle-'))
// The SID is per-process (audit U20) and the stager runs in a SUBPROCESS —
// it prints its own resume id; the assertion reads it from stdout.
const res = spawnSync(process.execPath, ['-e',
  `const { scenario } = await import('${join(import.meta.dir, 'renderScenarios.ts')}'); const cfg = scenario('resume-2turn', 80, 44); console.log(cfg.argv[cfg.argv.indexOf('--resume') + 1])`,
], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, MERCURY_CONFIG_DIR: tmp } })
const stagedSid = (res.stdout ?? '').trim().split('\n').pop() ?? ''
// The staging segment mirrors renderScenarios' own derivation (RUNTIME_CWD →
// sanitizePath) — a hardcoded calibration-machine segment is the F6 class.
const RUNTIME_CWD = (process.env.MERCURY_RENDER_CWD ?? join(import.meta.dir, '..', '..')).normalize('NFC')
const staged = join(tmp, 'projects', sanitizePath(RUNTIME_CWD), `${stagedSid}.jsonl`)
t('scenario() stages into MERCURY_CONFIG_DIR/projects', res.status === 0 && stagedSid.startsWith('00000000-aaaa-') && existsSync(staged),
  res.status !== 0 ? (res.stderr || '').trim().slice(0, 160) : staged)
rmSync(tmp, { recursive: true, force: true })

console.log(fail ? '❌ RENDER-ORACLE RED' : '✅ RENDER-ORACLE GREEN')
process.exit(fail)
