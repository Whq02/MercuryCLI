#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-motion-doors-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'

async function startFixture(port: number): Promise<{ base: string; calls: number; close(): Promise<void> }> {
  const state = { calls: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (url.includes('/v1/messages')) state.calls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    base: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; markTicks: Record<string, number>; receipts: number; sends: number; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'motion-doors-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; atTick: number; grid: Grid }>
    endReason?: string
  }
  const marks: Record<string, string> = {}
  const markTicks: Record<string, number> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    markTicks[m.label] = m.atTick
  }
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks,
    markTicks,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    endReason: payload.endReason ?? '',
    stderr: stderr.join(''),
  }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'motion-doors-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'motion-doors-cwd-')))
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

const rowsWith = (frame: string | undefined, needle: string | RegExp): string[] =>
  (frame ?? '').split('\n').filter(line => (typeof needle === 'string' ? line.includes(needle) : needle.test(line)))
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

console.log('============================================================')
console.log(" the Motion setting's two doors — real bundle, PTY")
console.log('============================================================')
const KEEP = process.env.MOTION_DOORS_KEEP === '1'
const { home, cwd } = seedWorld()
const folder = basename(cwd)
const fixture = await startFixture(Number(process.env.MOTION_DOORS_PORT ?? 25186))
const COLS = 160
const ROWS = 48
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
const ESC = '\x1b'
const SHIFT_RIGHT = '\x1b[1;2C'
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.ts')
const TO_MOTION = DOWN.repeat(STARTUP_MENU.length + 1)
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN],
      cwd,
      cols: COLS,
      rows: ROWS,
      sends: [
        { data: 'm', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
        { data: TO_MOTION, awaitText: 'SETTING DETAIL', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
        { data: RIGHT, awaitText: 'doors: /config · Boot Menu', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-motion' },
        { data: ESC, awaitText: 'motion full · set by you', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-full' },
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 2, awaitStableTicks: 4, awaitSettleTicks: 3 },
        { data: '/config\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: 'motion', awaitText: 'Motion', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'config-open' },
        { data: '\r', afterPrevTicks: 4 },
        { data: DOWN, afterPrevTicks: 3 },
        { data: RIGHT, afterPrevTicks: 4 },
        { data: '', awaitText: 'reduced', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'config-reduced' },
        { data: '\r', afterPrevTicks: 4 },
        { data: '/bootmenu\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'chat-reduced' },
        { data: TO_MOTION, awaitText: 'SETTING DETAIL', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
        { data: BACKSPACE, awaitText: 'now: reduced (set by you)', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-reduced' },
        { data: ESC, awaitText: 'follows the machine again', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-auto' },
        { data: SHIFT_RIGHT, awaitText: '↑↓ choose', requireAwait: true, minTick: 2, awaitStableTicks: 4, awaitSettleTicks: 3 },
        { data: SHIFT_RIGHT, awaitText: 'coordinator', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
        { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'chat-auto' },
        { data: '', afterPrevTicks: 3, mark: 'end' },
      ],
      stableTicks: 6,
      total: 800,
    },
    driveEnv(home, fixture.base),
    220_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

const MARKS = ['menu-motion', 'menu-full', 'config-open', 'config-reduced', 'chat-reduced', 'menu-reduced', 'menu-auto', 'chat-auto']
if (cap !== null) {
  const m = cap.marks
  console.log(`  marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason} · model calls on the wire: ${fixture.calls}`)
  if (KEEP) for (const label of MARKS) dump(label, m[label])
  check('every send became due (the frames the sends waited on all painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  if (cap.receipts !== cap.sends) dump('the final frame (a send never became due)', cap.text)

  const statusRows = (frame: string | undefined): string[] => rowsWith(frame, folder)

  console.log('\n— M1 the Boot Menu row —')
  const menu = m['menu-motion']
  check('M1 the PERFORMANCE section is on the menu', rowsWith(menu, 'PERFORMANCE').length > 0, rowsWith(menu, /PERFORMANCE|Motion/).map(flat).join(' | ').slice(0, 300))
  check('M1 the Motion row reads auto · full before any change', rowsWith(menu, /Motion\s+auto · full/).length > 0 || rowsWith(m['config-open'], /auto · full/).length > 0, rowsWith(menu, /Motion/).map(flat).join(' | ').slice(0, 300))
  check('M1 the detail names the doors and the word', rowsWith(menu, 'doors: /config · Boot Menu').length > 0 && rowsWith(menu, 'the status line says reduced').length > 0, rowsWith(menu, /doors|status line/).map(flat).join(' | ').slice(0, 300))
  check('M1 → sets full and the receipt says so', rowsWith(m['menu-full'], /motion full · set by you — applies now/).length > 0, rowsWith(m['menu-full'], /motion/).map(flat).join(' | ').slice(0, 300))

  console.log('\n— M2 the /config row —')
  check('M2 the /config row shows the value the Boot Menu set (full)', rowsWith(m['config-open'], /Motion/).some(r => /\bfull\b/.test(r)), rowsWith(m['config-open'], /Motion/).map(flat).join(' | ').slice(0, 300))
  check('M2 → moves it to reduced', rowsWith(m['config-reduced'], /Motion/).some(r => /\breduced\b/.test(r)), rowsWith(m['config-reduced'], /Motion/).map(flat).join(' | ').slice(0, 300))

  console.log('\n— M3 the status line —')
  check('M3 back in the chat the status line says reduced', statusRows(m['chat-reduced']).some(r => /\breduced\b/.test(r)), statusRows(m['chat-reduced']).map(flat).join(' | ').slice(0, 300))

  console.log('\n— M4 the Boot Menu again —')
  check('M4 the Boot Menu shows the value the /config door set (reduced · set by you)', rowsWith(m['menu-reduced'], /now: reduced \(set by you\)/).length > 0 && rowsWith(m['menu-reduced'], /Motion\s+reduced/).length > 0, rowsWith(m['menu-reduced'], /Motion|now:/).map(flat).join(' | ').slice(0, 300))
  check('M4 ⌫ returns it to auto and the receipt says the machine decides again', rowsWith(m['menu-auto'], /motion follows the machine again \(auto · full\)/).length > 0, rowsWith(m['menu-auto'], /motion/).map(flat).join(' | ').slice(0, 300))
  check('M4 the status word is gone once the value is auto on a machine that keeps up', statusRows(m['chat-auto']).length > 0 && !statusRows(m['chat-auto']).some(r => /\breduced\b/.test(r)), statusRows(m['chat-auto']).map(flat).join(' | ').slice(0, 300))
  check('no setting made a model call', fixture.calls === 0, String(fixture.calls))
  if (failures > 0 && !KEEP) for (const label of MARKS) dump(label, m[label])
}

if (!KEEP) {
  for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ motion doors drive GREEN' : `\n❌ motion doors drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
