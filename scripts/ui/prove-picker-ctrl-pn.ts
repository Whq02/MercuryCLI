#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const CTRL_N = String.fromCharCode(0x0e)
const CTRL_P = String.fromCharCode(0x10)
const ENTER = String.fromCharCode(0x0d)
const ARROW_DOWN = String.fromCharCode(0x1b) + '[B'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 800) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the probe cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'picker-ctrl-pn-'))
const home = join(scratch, 'home')
seedFirstRun(home, [ROOT])
mkdirSync(join(home, 'daemon'), { recursive: true })
const grid = join(scratch, 'grid.json')
const cfg = join(scratch, 'vshot.json')
writeFileSync(
  cfg,
  JSON.stringify({
    argv: ['node', DIST, '--chat'],
    sends: [
      { atTick: 40, awaitText: 'Doctor / Health Check', minTick: 20, awaitSettleTicks: 2, requireAwait: true, data: ENTER },
      { atTick: 110, awaitText: 'Type a prompt', minTick: 50, awaitSettleTicks: 4, requireAwait: true, data: '/model' + ENTER },
      { atTick: 160, awaitText: 'Mercury — model', minTick: 100, awaitSettleTicks: 3, requireAwait: true, mark: 'open', data: CTRL_N },
      { afterPrevTicks: 4, mark: 'after-ctrl-n', data: CTRL_P },
      { afterPrevTicks: 4, mark: 'after-ctrl-p', data: ARROW_DOWN },
      { afterPrevTicks: 4, mark: 'after-down', data: '' },
    ],
    total: 200,
    cols: 120,
    rows: 40,
    out: grid,
    title: 'picker-ctrl-pn',
  }),
)
const res = spawnSync(driver.python, [VSHOT, cfg], {
  encoding: 'utf-8',
  cwd: ROOT,
  timeout: vshotBudgetMs(150_000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    TERM: 'xterm-256color',
  },
})
const marks: Record<string, string> = {}
let endReason = ''
if (existsSync(grid)) {
  const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
    marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
    endReason?: string
  }
  const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
  for (const m of payload.marks ?? []) marks[m.label] = text(m.grid)
  endReason = payload.endReason ?? ''
}
const open = marks.open ?? ''
const afterN = marks['after-ctrl-n'] ?? ''
const afterP = marks['after-ctrl-p'] ?? ''
const afterDown = marks['after-down'] ?? ''
check('the drive delivered (the picker opened, every mark taken)', res.status === 0 && open.includes('Mercury — model') && afterN !== '' && afterP !== '' && afterDown !== '', `status=${res.status} end=${endReason} ${(res.stderr ?? '').slice(-300)}\n${open.split('\n').slice(0, 8).join('\n')}`)
const diffRows = (a: string, b: string): number[] => {
  const x = a.split('\n')
  const y = b.split('\n')
  const out: number[] = []
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(i)
  return out
}
const nMoved = diffRows(open, afterN)
check('ctrl+n reaches the picker: the frame moves', nMoved.length > 0, `open==after-ctrl-n; the open frame:\n${open}`)
check('ctrl+p reaches the picker: the frame returns to the open frame', afterP === open, `rows differing: ${diffRows(open, afterP).join(',')}\n${afterP}`)
check('the control ↓ moves the frame exactly as ctrl+n did', afterDown === afterN, `rows differing from after-ctrl-n: ${diffRows(afterN, afterDown).join(',')}; ↓ moved rows ${diffRows(afterP, afterDown).join(',')}`)

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ picker-ctrl-pn — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ picker-ctrl-pn — ctrl+p and ctrl+n reach the /model picker and move it as the arrows do')
