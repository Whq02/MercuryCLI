#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  console.error(`prove-rename-hosted-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const NAME = 'mail-run'

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; endReason: string; stderr: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'rename-hosted-cfg-'))
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
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), marks, endReason: payload.endReason ?? '', stderr: stderr.join('') }
}

const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const home = realpathSync(mkdtempSync(join(tmpdir(), 'rename-hosted-home-')))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rename-hosted-cwd-')))
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
seedFirstRun(home, [cwd])
const env: Record<string, string> = {
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_TABULA_DIR: join(home, 'tabula'),
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${await closedPort()}`,
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  OPENAI_API_KEY: '',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
}

const headerRow = (frame: string | undefined): string => (frame ?? '').split('\n').find(r => r.includes('✶ SESSION')) ?? ''
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

console.log('============================================================')
console.log(' /rename in a hosted chat renames the session — real bundle, PTY')
console.log('============================================================')
let cap: Capture | null = null
try {
  cap = await capture(
    {
      argv: ['node', BIN, '--chat'],
      cwd,
      cols: 120,
      rows: 40,
      sends: [
        { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitSettleTicks: 8 },
        { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'idle' },
        { data: `/rename ${NAME}\r`, afterPrevTicks: 2 },
        { data: '', awaitText: NAME, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'renamed' },
        { data: '/exit\r', afterPrevTicks: 2 },
      ],
      total: 160,
    },
    env,
    120_000,
  )
} catch (error) {
  check('the capture ran', false, String(error).slice(0, 400))
}

if (cap !== null) {
  const m = cap.marks
  for (const label of ['idle', 'renamed']) {
    console.log(`\n── ${label} ──`)
    for (const row of (m[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row}`)
  }
  check('R1 the idle chat\'s title row reads the unnamed word', headerRow(m['idle']).includes('new session'), flat(headerRow(m['idle'])))
  check(`R2 after /rename the title row reads "${NAME}"`, headerRow(m['renamed']).includes(NAME), flat(headerRow(m['renamed'])))
  check('R2 the unnamed word left the title row', !headerRow(m['renamed']).includes('new session'), flat(headerRow(m['renamed'])))
  check('R3 the confirmation names the rename', (m['renamed'] ?? '').includes(`Renamed this session to ${NAME}`), flat(m['renamed'] ?? '').slice(0, 300))
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-rename-hosted-drive: all green' : `\nprove-rename-hosted-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
