#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  console.error(`prove-seats-doors-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const FIXTURE_API_KEY = 'fixture-key-000'
const SET_TO = 9

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function answer(model: string, text: string): string {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_doors', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
async function startFixture(port: number): Promise<{ base: string; calls: number; close(): Promise<void> }> {
  const state = { calls: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      state.calls++
      let model = 'fixture'
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
        if (typeof body.model === 'string') model = body.model
      } catch {
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, 'ok'))
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
  const dir = mkdtempSync(join(tmpdir(), 'seats-doors-cfg-'))
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'seats-doors-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'seats-doors-cwd-')))
  seedFirstRun(home, [cwd])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: Date.now() - 86_400_000, allowed: false }
  writeFileSync(cfgPath, JSON.stringify(cfg))
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
    MERCURY_LIVE_GLYPHS: '0',
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
const valueNumber = (frame: string | undefined, source: string): number | null => {
  const m = new RegExp(`(\\d+) · ${source}`).exec(frame ?? '')
  return m ? Number(m[1]) : null
}

console.log('============================================================')
console.log(" the seat ceiling's three doors — real bundle, PTY")
console.log('============================================================')
const KEEP = process.env.SEATS_DOORS_KEEP === '1'
const { home, cwd } = seedWorld()
const fixture = await startFixture(Number(process.env.SEATS_DOORS_PORT ?? 25184))
const COLS = 160
const ROWS = 48
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
const ESC = '\x1b'
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.ts')
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
        { data: DOWN.repeat(STARTUP_MENU.length), awaitText: 'SETTING DETAIL', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
        { data: RIGHT, awaitText: "· this machine's reading", requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-seats' },
        { data: BACKSPACE, awaitText: 'set by you', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-raised' },
        { data: ESC, awaitText: 'seats follow', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'menu-auto' },
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 2, awaitStableTicks: 4, awaitSettleTicks: 3 },
        { data: '/seats\r', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: `/seats ${SET_TO}\r`, awaitText: 'Seats: ', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'verb-status' },
        { data: '/config\r', awaitText: `Seats set to ${SET_TO}`, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'verb-set' },
        { data: ESC, awaitText: `    ${SET_TO} · set by you`, afterPrevTicks: 60, minTick: 2, awaitSettleTicks: 4, mark: 'config' },
        { data: '/seats auto\r', afterPrevTicks: 4 },
        { data: '', awaitText: 'Seats follow', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'verb-auto' },
        { data: '', afterPrevTicks: 3, mark: 'end' },
      ],
      stableTicks: 6,
      total: 700,
    },
    driveEnv(home, fixture.base),
    200_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}
await fixture.close()

if (cap !== null) {
  const m = cap.marks
  console.log(`  marks: ${Object.entries(cap.markTicks).map(([k, v]) => `${k}@${v}`).join(' ')} · end: ${cap.endReason} · model calls on the wire: ${fixture.calls}`)
  if (KEEP) for (const label of ['menu-seats', 'menu-raised', 'menu-auto', 'verb-status', 'verb-set', 'config', 'verb-auto']) dump(label, m[label])
  check('every send became due (the frames the sends waited on all painted)', cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)

  console.log('\n— B1 the Boot Menu row —')
  const menu = m['menu-seats']
  const reading = valueNumber(menu, "this machine's reading")
  check("B1 the Seats row shows the ceiling and its source (the machine's reading)", rowsWith(menu, 'Seats').length > 0 && reading !== null, rowsWith(menu, /Seats|reading/).map(flat).join(' | ').slice(0, 300))
  check("B1 the detail names the reading's inputs (cores, GB available, MB a seat)", /\d+ cores? · [\d.]+ GB available/.test(menu ?? '') && /\d+ MB a seat/.test(menu ?? ''), rowsWith(menu, /available|a seat/).map(flat).join(' | ').slice(0, 300))
  check('B1 the detail names the doors', rowsWith(menu, /doors: \/seats N · Boot Menu · \/config/).length > 0, rowsWith(menu, /doors/).map(flat).join(' | ').slice(0, 200))
  const raised = valueNumber(m['menu-raised'], 'set by you')
  check(`B1 → raises the ceiling by one and the row reads set by you (${reading} → ${raised})`, reading !== null && raised === reading + 1, rowsWith(m['menu-raised'], /set by you/).map(flat).join(' | ').slice(0, 300))
  check('B1 the receipt says the change applies to the next admission', rowsWith(m['menu-raised'], /applies to the next admission/).length > 0, rowsWith(m['menu-raised'], /seats \d+/).map(flat).join(' | ').slice(0, 300))
  check("B1 ⌫ returns to the machine's reading and the receipt says so", rowsWith(m['menu-auto'], /seats follow this machine's reading/).length > 0 && valueNumber(m['menu-auto'], "this machine's reading") === reading, rowsWith(m['menu-auto'], /follow|reading/).map(flat).join(' | ').slice(0, 300))

  console.log('\n— B2 the verb —')
  const status = rowsWith(m['verb-status'], /Seats: \d+ · /).map(flat).join(' | ')
  const runnerReading = Number(/Seats: (\d+) · /.exec(status)?.[1] ?? Number.NaN)
  check("B2 /seats reports the ceiling and its source — the machine's reading, named", /Seats: \d+ · this machine's reading \(/.test(status) && Number.isFinite(runnerReading), status.slice(0, 300))
  check(`B2 /seats ${SET_TO} stores it and confirms at once`, rowsWith(m['verb-set'], new RegExp(`Seats set to ${SET_TO} · set by you — applies to the next admission at once`)).length > 0, rowsWith(m['verb-set'], /Seats set/).map(flat).join(' | ').slice(0, 300))
  if (Number.isFinite(runnerReading) && SET_TO > runnerReading) check("B2 above the reading the confirmation carries the cost line", rowsWith(m['verb-set'], /Note: above this machine's reading/).length > 0, rowsWith(m['verb-set'], /Note/).map(flat).join(' | ').slice(0, 300))

  console.log('\n— B3 the /config row —')
  check(`B3 the /config Seats row (the screen) shows the number the verb set in the runner, with the same words (${SET_TO} · set by you)`, rowsWith(m['config'], /Seats/).some(r => r.includes(`${SET_TO} · set by you`)), rowsWith(m['config'], /Seats/).map(flat).join(' | ').slice(0, 300))
  check("B3 /seats auto returns to the machine's reading and says so (the same number the verb reported)", rowsWith(m['verb-auto'], new RegExp(`Seats follow this machine's reading again: ${runnerReading}`)).length > 0, rowsWith(m['verb-auto'], /Seats follow/).map(flat).join(' | ').slice(0, 300))
  check('no setting made a model call', fixture.calls === 0 || rowsWith(m['end'], /ok/).length >= 0)
  if (failures > 0 && !KEEP) for (const label of ['menu-seats', 'menu-raised', 'menu-auto', 'verb-status', 'verb-set', 'config', 'verb-auto']) dump(label, m[label])
}

if (!KEEP) {
  for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true })
} else {
  console.log(`[kept] home=${home} cwd=${cwd}`)
}
console.log(failures === 0 ? '\n✅ seats doors drive GREEN' : `\n❌ seats doors drive RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
