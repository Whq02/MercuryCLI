#!/usr/bin/env bun
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
t('near-blank capture rejected', !blank.ok && blank.reason.includes('blank'), blank.reason)

const err = evaluateCapture(grid([
  `No conversation found with session ID: 00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`,
  'run with --resume <id> or --continue to pick the latest conversation instead',
]))
t('boot-error screen rejected despite painted>=40', !err.ok && err.reason.includes('boot-error'), err.reason)

const noChrome = evaluateCapture(grid([
  'the quick brown fox jumps over the lazy dog and keeps on running far away',
  'another line of plain output text that is definitely not the mercury chrome',
]))
t('chrome-less capture rejected', !noChrome.ok && noChrome.reason.includes('chrome'), noChrome.reason)

const good = evaluateCapture(grid([
  '╭──────────────────────────────────────────╮',
  '│  MERCURY                                 │',
  '│  first task                              │',
  '╰──────────────────────────────────────────╯',
  '❯ ',
]))
t('healthy capture accepted', good.ok, good.reason)

const tmp = mkdtempSync(join(tmpdir(), 'mercury-oracle-'))
const res = spawnSync(process.execPath, ['-e',
  `const { scenario } = await import('${join(import.meta.dir, 'renderScenarios.ts')}'); const cfg = scenario('resume-2turn', 80, 44); console.log(cfg.argv[cfg.argv.indexOf('--resume') + 1])`,
], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, MERCURY_CONFIG_DIR: tmp, MERCURY_DAEMON_DIR: join(tmp, 'daemon') } })
const stagedSid = (res.stdout ?? '').trim().split('\n').pop() ?? ''
const RUNTIME_CWD = (process.env.MERCURY_RENDER_CWD ?? join(import.meta.dir, '..', '..')).normalize('NFC')
const staged = join(tmp, 'projects', sanitizePath(RUNTIME_CWD), `${stagedSid}.jsonl`)
t('scenario() stages into MERCURY_CONFIG_DIR/projects', res.status === 0 && stagedSid.startsWith('00000000-aaaa-') && existsSync(staged),
  res.status !== 0 ? (res.stderr || '').trim().slice(0, 160) : staged)
rmSync(tmp, { recursive: true, force: true })

console.log(fail ? '❌ RENDER-ORACLE RED' : '✅ RENDER-ORACLE GREEN')
process.exit(fail)
