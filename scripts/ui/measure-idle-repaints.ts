#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`measure-idle-repaints: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

const COLS = Number(process.env.MEASURE_COLS ?? '120')
const ROWS = Number(process.env.MEASURE_ROWS ?? '40')
const WINDOW_SKIP_MS = 2_000
const WINDOW_MS = 60_000
const VARIANTS: Record<string, Record<string, string>> = {
  default: {},
  'clock-off': { MERCURY_LIVE_CLOCK: '0' },
}
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(VARIANTS)

async function startFixture(port: number): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'idle-repaints-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'idle-repaints-cwd-')))
  writeFileSync(join(cwd, 'notes.txt'), 'idle notes\n')
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function baseEnv(home: string, fixtureBase: string): Record<string, string> {
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
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

type Receipt = { atTick: number; ts: number }
async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<{ receipts: Receipt[]; endReason: string; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'idle-repaints-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Array<Array<{ c?: string }>>; sendReceipts?: Receipt[]; endReason?: string }
  rmSync(dir, { recursive: true, force: true })
  return {
    receipts: payload.sendReceipts ?? [],
    endReason: payload.endReason ?? '',
    text: payload.grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n'),
  }
}

const outDir = process.env.MEASURE_OUT_DIR ?? mkdtempSync(join(tmpdir(), 'idle-repaints-tee-'))
mkdirSync(outDir, { recursive: true })
console.log('============================================================')
console.log(` idle repaints — the built bundle, ${COLS}×${ROWS}, one idle minute per variant`)
console.log('============================================================')
const fixture = await startFixture(Number(process.env.MEASURE_PORT ?? 25231))
const results: Array<{ variant: string; writes: number; bytes: number; secondsWithWrites: number; endReason: string }> = []
for (const variant of wanted) {
  const extra = VARIANTS[variant]
  if (extra === undefined) {
    console.log(`  ? unknown variant ${variant} (known: ${Object.keys(VARIANTS).join(', ')})`)
    continue
  }
  const { home, cwd } = seedWorld()
  const tee = join(outDir, `tee-${variant}.jsonl`)
  rmSync(tee, { force: true })
  rmSync(`${tee}.raw`, { force: true })
  const settleTicks = 50
  const total = 12 * 5 + settleTicks + Math.ceil((WINDOW_SKIP_MS + WINDOW_MS) / 200) + 25
  let cap: Awaited<ReturnType<typeof capture>> | null = null
  try {
    cap = await capture(
      {
        argv: ['node', BIN],
        cwd,
        cols: COLS,
        rows: ROWS,
        sends: [
          { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitSettleTicks: 6 },
          { data: '', afterPrevTicks: settleTicks, mark: 'settled' },
        ],
        total,
      },
      { ...baseEnv(home, fixture.base), ...extra, INK_WRITE_TEE: tee },
      total * 200 + 30_000,
    )
  } catch (error) {
    console.log(`  ✗ ${variant}: the capture failed — ${String(error).slice(0, 300)}`)
  }
  if (cap !== null) {
    const start = (cap.receipts[1]?.ts ?? 0) + WINDOW_SKIP_MS
    const end = start + WINDOW_MS
    let writes = 0
    let bytes = 0
    const seconds = new Set<number>()
    const samples = new Map<string, number>()
    if (existsSync(tee)) {
      for (const line of readFileSync(tee, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        let row: { ts?: number; len?: number; sample?: string }
        try {
          row = JSON.parse(line) as { ts?: number; len?: number; sample?: string }
        } catch {
          continue
        }
        if (typeof row.ts !== 'number' || row.ts < start || row.ts >= end) continue
        writes += 1
        bytes += row.len ?? 0
        seconds.add(Math.floor((row.ts - start) / 1000))
        const key = (row.sample ?? '').replace(/\d/g, '#').slice(0, 24)
        samples.set(key, (samples.get(key) ?? 0) + 1)
      }
    }
    const chatOpen = cap.text.includes('✶ SESSION')
    results.push({ variant, writes, bytes, secondsWithWrites: seconds.size, endReason: cap.endReason })
    console.log(`\n── ${variant} ──`)
    console.log(`  window: ${new Date(start).toISOString()} → +${WINDOW_MS / 1000}s · capture ended: ${cap.endReason} · cockpit header on screen: ${chatOpen ? 'yes' : 'NO'}`)
    console.log(`  writes in the idle minute: ${writes} · bytes: ${bytes} · seconds carrying a write: ${seconds.size}/60`)
    const top = [...samples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    if (top.length > 0) console.log(`  write shapes (digits masked): ${top.map(([k, n]) => `${n}× ${JSON.stringify(k)}`).join(' · ')}`)
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
await fixture.close()
console.log('\n── summary (per idle minute) ──')
for (const r of results) console.log(`  ${r.variant.padEnd(10)} writes=${r.writes} bytes=${r.bytes} seconds-with-writes=${r.secondsWithWrites}`)
if (process.env.MEASURE_OUT_DIR === undefined) rmSync(outDir, { recursive: true, force: true })
else console.log(`  tee files kept under ${outDir}`)
