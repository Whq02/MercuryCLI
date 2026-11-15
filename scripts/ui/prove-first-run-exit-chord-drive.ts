#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const DEAD = 'http://127.0.0.1:1'
const TICKS_A_SECOND = 5
const WATCH_S = 30
const CHORD_NOTICE = 'press ctrl+c twice to close Mercury'
const STAYS_S = 12

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

if (!existsSync(BIN)) {
  console.error(`  ${BIN} missing — bun run build.ts first (or pass --dist <bundle>)`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(1)
}
const PYTHON = driver.python
const VENDORED_NODE = join(dirname(BIN), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')

type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; endReason: string; endedAtTick: number; sentAtTick: number; marks: Record<string, string>; final: string; note: string }
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, '')).join('\n')

const atTheThemeStep = (data: string): Record<string, unknown> => ({ requireAwait: true, awaitText: 'esc exits', minTick: 3, awaitSettleTicks: 5, mark: 'up', data })
const atTheNotice = (data: string): Record<string, unknown> => ({ requireAwait: true, awaitText: CHORD_NOTICE, awaitSettleTicks: 1, mark: 'noticed', data })

async function firstRun(label: string, sends: Array<Record<string, unknown>>, lastScene: string, staysS: number): Promise<Capture> {
  const root = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'first-run-chord-')))
  try {
    const home = join(root, 'home')
    const userHome = join(root, 'user')
    const cwd = join(root, 'repo')
    for (const dir of [home, userHome, cwd, join(root, 'tmp')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(cwd, 'README.md'), 'a fixture folder for the first-run drive\n')
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: userHome,
      TMPDIR: join(root, 'tmp'),
      TERM: process.env.TERM ?? 'xterm-256color',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      BROWSER: 'true',
      ANTHROPIC_BASE_URL: DEAD,
      MERCURY_OPENAI_API_BASE: DEAD,
      MERCURY_OPENAI_AUTH_BASE: DEAD,
      MERCURY_OPENROUTER_API_BASE: DEAD,
      MERCURY_GEMINI_API_BASE: DEAD,
      MERCURY_ANTHROPIC_OAUTH_BASE: DEAD,
      VSHOT_SLOTS: '999',
    }
    for (const key of ['MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_VSHOT_EMULATOR', 'PYTHONPATH']) if (process.env[key] !== undefined) env[key] = process.env[key]
    const out = join(root, 'capture.json')
    const cfgPath = join(root, 'capture.cfg.json')
    writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN], cwd, cols: 120, rows: 40, total: WATCH_S * TICKS_A_SECOND, sends, readyText: lastScene, readySettleTicks: staysS * TICKS_A_SECOND, out }))
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout!.on('data', () => {})
    child.stderr!.on('data', chunk => {
      stderr += String(chunk)
    })
    const status = await new Promise<number | null>(settle => {
      const budget = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WATCH_S * 1000 + 90_000))
      child.on('exit', code => {
        clearTimeout(budget)
        settle(code)
      })
    })
    const note = stderr.split('\n').filter(line => /UNDELIVERED|NEVER-READY|refus/i.test(line)).join(' ').replace(/\s+/g, ' ').trim()
    if (!existsSync(out)) return { status, endReason: 'no capture', endedAtTick: -1, sentAtTick: -1, marks: {}, final: '', note: note || stderr.trim().split('\n').slice(-4).join(' | ') }
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; endReason: string; endedAtTick: number; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: Array<{ tick?: number }> }
    const marks: Record<string, string> = {}
    for (const mark of payload.marks ?? []) marks[mark.label] = textOf(mark.grid)
    const receipts = payload.sendReceipts ?? []
    console.log(`  ${label}: the watch ended at tick ${payload.endedAtTick} (${payload.endReason}); ${receipts.length} of ${sends.length} sends delivered`)
    return { status, endReason: payload.endReason, endedAtTick: payload.endedAtTick, sentAtTick: Number(receipts.at(-1)?.tick ?? -1), marks, final: textOf(payload.grid), note }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const footOf = (frame: string | undefined): string => (frame ?? '').split('\n').filter(line => /esc exits|ctrl\+c/.test(line)).map(line => line.replace(/[│╰╯─]/g, ' ').replace(/\s+/g, ' ').trim()).join(' | ')

section('the first run on a new config folder, 120x40: its theme step, the way out by keys')
const once = await firstRun('Ctrl+C once', [atTheThemeStep('\u0003'), atTheNotice('')], CHORD_NOTICE, 2)
check('the first run comes up on its theme step, which names esc as the way out (holds on the parent too)', footOf(once.marks.up).includes('esc exits'), `${once.endReason} ${once.note} ${footOf(once.marks.up)}`)
check('Ctrl+C once says what a second one does and ends nothing (holds on the parent too)', footOf(once.marks.noticed).includes(CHORD_NOTICE) && once.endReason === 'ready', `${once.endReason} at tick ${once.endedAtTick}: ${footOf(once.marks.noticed)} ${once.note}`)

const twice = await firstRun('Ctrl+C twice', [atTheThemeStep('\u0003'), atTheNotice('\u0003')], CHORD_NOTICE, STAYS_S)
check(`Ctrl+C twice ends the process: its terminal closes inside the ${STAYS_S} s the watch stays after the second one`, twice.endReason === 'eof' && twice.endedAtTick > 0, `the watch ended by ${twice.endReason} at tick ${twice.endedAtTick}: the process outlived the screen it had handed back. ${twice.note}`)

const escaped = await firstRun('Esc', [atTheThemeStep('\u001b')], 'esc exits', STAYS_S)
check('Esc ends it too, as its footer says (holds on the parent too)', escaped.endReason === 'eof' && escaped.endedAtTick > 0, `the watch ended by ${escaped.endReason} at tick ${escaped.endedAtTick}. ${escaped.note}`)

console.log(`\n${4 - failures} of 4 checks hold`)
console.log(failures === 0 ? 'prove-first-run-exit-chord-drive: ALL HOLD' : `prove-first-run-exit-chord-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
