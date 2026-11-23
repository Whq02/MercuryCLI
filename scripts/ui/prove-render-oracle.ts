#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { evaluateCapture, type CapturedGrid } from './renderOracle.ts'

let fail = 0
const t = (name: string, ok: boolean, detail = '', hint = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) fail = 1
}

function grid(lines: string[], cols = 80, rows = 24): CapturedGrid {
  return {
    cols, rows,
    grid: Array.from({ length: rows }, (_, y) => {
      const line = lines[y] ?? ''
      return Array.from({ length: cols }, (_, x) => ({ c: line[x] ?? ' ' }))
    }),
  }
}

const blank = evaluateCapture(grid(['❯ hi']))
t('near-blank capture rejected', !blank.ok && blank.reason.includes('blank'), blank.reason, 'Fix evaluateCapture in scripts/ui/renderOracle.ts so a capture with few painted cells is rejected with a reason naming blank.')

const err = evaluateCapture(grid([
  `No conversation found for session id 00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`,
  'run with --resume <id> or --continue to pick the latest conversation instead',
]))
t('boot-error screen rejected despite painted>=40', !err.ok && err.reason.includes('boot-error'), err.reason, 'Fix evaluateCapture in scripts/ui/renderOracle.ts so a screen matching BOOT_ERROR_SIGNATURES is rejected with a reason naming boot-error before the chrome check.')

const noChrome = evaluateCapture(grid([
  'the quick brown fox jumps over the lazy dog and keeps on running far away',
  'another line of plain output text that is definitely not the mercury chrome',
]))
t('chrome-less capture rejected', !noChrome.ok && noChrome.reason.includes('chrome'), noChrome.reason, 'Fix evaluateCapture in scripts/ui/renderOracle.ts so a capture without any CHROME_MARKERS is rejected with a reason naming chrome.')

const good = evaluateCapture(grid([
  '╭──────────────────────────────────────────╮',
  '│  MERCURY                                 │',
  '│  first task                              │',
  '╰──────────────────────────────────────────╯',
  '❯ ',
]))
t('healthy capture accepted', good.ok, good.reason, 'Fix evaluateCapture in scripts/ui/renderOracle.ts so a capture with enough painted cells and a CHROME_MARKERS glyph is accepted.')

const tmp = mkdtempSync(join(tmpdir(), 'mercury-oracle-'))
const res = spawnSync(process.execPath, ['-e',
  `const { scenario, RUNTIME_CWD } = await import('${join(import.meta.dir, 'renderScenarios.ts')}'); const { getProjectDir } = await import('${join(import.meta.dir, '../../src/sessions/transcripts/sessionStoragePortable.ts')}'); const { join } = await import('node:path'); const cfg = scenario('resume-2turn', 80, 44); console.log(join(getProjectDir(RUNTIME_CWD), cfg.argv[cfg.argv.indexOf('--resume') + 1] + '.jsonl'))`,
], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, MERCURY_CONFIG_DIR: tmp, MERCURY_DAEMON_DIR: join(tmp, 'daemon') } })
const staged = (res.stdout ?? '').trim().split('\n').pop() ?? ''
t('scenario() stages in the product-resolved store under MERCURY_CONFIG_DIR/projects',
  res.status === 0 && staged.startsWith(join(tmp, 'projects') + sep) &&
    basename(staged).startsWith('00000000-aaaa-') && existsSync(staged),
  res.status !== 0 ? (res.stderr || '').trim().slice(0, 160) : staged,
  'Fix the resume-2turn scenario in scripts/ui/renderScenarios.ts to stage its session file under getProjectDir(RUNTIME_CWD), which follows MERCURY_CONFIG_DIR.')
rmSync(tmp, { recursive: true, force: true })

console.log(fail ? '❌ RENDER-ORACLE RED' : '✅ RENDER-ORACLE GREEN')
process.exit(fail)
