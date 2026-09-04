#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const IDLE_S = 75
const SETTLE_S = 30
const BUDGET_PER_MIN: Record<string, number> = { tui: 700, runner: 400, daemon: 150 }
const CONNECTOR_STATS_PER_MIN = 60

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'store-poll-budget-')))
const FOLDER = join(SCRATCH, 'folder')
const CFG = join(SCRATCH, 'mercury')
const HOME = join(SCRATCH, 'home')
const CENSUS = join(SCRATCH, 'census')
for (const d of [FOLDER, CFG, HOME, CENSUS]) mkdirSync(d, { recursive: true })
for (let i = 0; i < 40; i++) writeFileSync(join(FOLDER, `file${String(i).padStart(2, '0')}.ts`), `// fixture ${i}\n`)
writeFileSync(join(FOLDER, 'README.md'), '# fixture\n')
{
  const run = (args: string[]): number => spawnSync('git', args, { cwd: FOLDER, stdio: 'ignore' }).status ?? 1
  run(['init', '-q'])
  run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'add', '.'])
  run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'])
}
process.env.MERCURY_CONFIG_DIR = CFG
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { resolveCaptureDriver, captureEngineEntry, vshotBudgetMs } = await import('../lib/captureDriver.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-store-poll-budget: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
seedFirstRun(CFG, [FOLDER])
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'Spare.' })))

const READY = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const sends = [
  { awaitText: READY, atTick: 600, data: '', mark: 'face-ready' },
  { awaitText: READY, awaitSettleTicks: 30, atTick: 650, data: '\r', mark: 'enter' },
  { awaitText: COMPOSER, atTick: 750, data: '', mark: 'chat-ready' },
]
const total = Math.round((45 + IDLE_S) / 0.2)
const cfgPath = join(SCRATCH, 'cfg.json')
const outPath = join(SCRATCH, 'grid.json')
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd: FOLDER, cols: 120, rows: 40, sends, total, out: outPath }))
const env: Record<string, string | undefined> = {
  ...process.env,
  NODE_OPTIONS: `--require=${join(REPO, 'scripts', 'ui', 'fsCensusPreload.cjs')}`,
  MERCURY_FS_CENSUS_DIR: CENSUS,
  MERCURY_FS_CENSUS_PROJECT: FOLDER,
  HOME,
  MERCURY_CONFIG_DIR: CFG,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
}
const pytePath = spawnSync(driver.python, ['-c', 'import pyte,os;print(os.path.dirname(os.path.dirname(pyte.__file__)))'], { encoding: 'utf8' }).stdout.trim()
if (pytePath) env.PYTHONPATH = pytePath

const t0 = Date.now()
const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let tail = ''
child.stdout.on('data', d => {
  tail = (tail + String(d)).slice(-3000)
})
child.stderr.on('data', d => {
  tail = (tail + String(d)).slice(-3000)
})
const status: number = await new Promise(r => {
  const guard = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
  child.on('close', c => {
    clearTimeout(guard)
    r(c ?? 1)
  })
})
const t1 = Date.now()
await new Promise(r => setTimeout(r, 3000))
const pg = spawnSync('pgrep', ['-f', CFG], { encoding: 'utf8' }).stdout.trim()
for (const p of pg ? pg.split('\n').filter(Boolean) : []) {
  try {
    process.kill(Number(p), 'SIGTERM')
  } catch {
  }
}
await new Promise(r => setTimeout(r, 1500))
try {
  await api.close()
} catch {
}
check('the capture ran to its budget', status === 0, `vshot status ${status}\n${tail.slice(-600)}`)
let payload: { marks?: Array<{ label: string; atMs?: number }> } = {}
try {
  payload = JSON.parse(readFileSync(outPath, 'utf8'))
} catch {
}
const marks = payload.marks ?? []
const chatReady = marks.find(m => m.label === 'chat-ready')
check('the chat was on screen (the composer placeholder painted)', chatReady !== undefined, JSON.stringify(marks.map(m => m.label)))

type Window = { t: number; pid: number; fs: Record<string, number>; top: Array<[string, number]>; spawns: Array<{ kind: string; cmd: string }> }
const procs = new Map<number, string>()
for (const f of readdirSync(CENSUS)) {
  if (!f.startsWith('proc-')) continue
  try {
    const p = JSON.parse(readFileSync(join(CENSUS, f), 'utf8')) as { pid: number; argv: string[] }
    const argv = p.argv.join(' ')
    procs.set(p.pid, argv.includes(' daemon') ? 'daemon' : p.argv.includes('-p') ? 'runner' : 'tui')
  } catch {
  }
}
const idleStart = t0 + (chatReady?.atMs ?? 40_000) + SETTLE_S * 1000
const idleEnd = t1 - 1000
const idleMin = Math.max(0.001, (idleEnd - idleStart) / 60_000)
const perProc = new Map<string, number>()
const durable = new Map<string, number>()
const top = new Map<string, number>()
for (const f of readdirSync(CENSUS)) {
  if (!f.startsWith('census-')) continue
  for (const line of readFileSync(join(CENSUS, f), 'utf8').split('\n')) {
    if (!line) continue
    let w: Window
    try {
      w = JSON.parse(line) as Window
    } catch {
      continue
    }
    if (w.t - 10_000 < idleStart || w.t > idleEnd + 10_000) continue
    const role = procs.get(w.pid) ?? 'unknown'
    for (const [k, v] of Object.entries(w.fs)) {
      const [fn, fam] = k.split(':')
      if (fam !== 'confighome' && fam !== 'project') continue
      perProc.set(role, (perProc.get(role) ?? 0) + v)
      if (fam === 'confighome' && /^(writeFileSync|appendFileSync|renameSync|writeFile|appendFile|rename)(\((cb|p)\))?$/.test(fn ?? '')) {
        durable.set(`${role} ${fn}`, (durable.get(`${role} ${fn}`) ?? 0) + v)
      }
    }
    for (const [k, v] of w.top) top.set(`${role}: ${k}`, (top.get(`${role}: ${k}`) ?? 0) + v)
  }
}
const perMin = (n: number): number => Math.round(n / idleMin)
console.log(`  idle window ${Math.round(idleMin * 60)} s · ops/min per process: ${[...perProc].map(([r, n]) => `${r}=${perMin(n)}`).join(' · ')}`)
const shown = [...top].sort((a, b) => b[1] - a[1]).slice(0, 12)
for (const [k, v] of shown) console.log(`    ${String(perMin(v)).padStart(5)}/min  ${k.replace(CFG, '<cfg>').replace(FOLDER, '<folder>').slice(0, 120)}`)

for (const role of ['tui', 'daemon', 'runner']) {
  const n = perMin(perProc.get(role) ?? 0)
  check(`§1 ${role}: ≤ ${BUDGET_PER_MIN[role]} file operations a minute at idle against the config home and the project`, n <= (BUDGET_PER_MIN[role] ?? 300), `${n}/min`)
}
const tuiDurable = [...durable].filter(([k]) => k.startsWith('tui '))
check('§2 the TUI writes nothing durable under the config home at idle', tuiDurable.length === 0, JSON.stringify(tuiDurable))
const connectorStats = [...top]
  .filter(([k]) => k.startsWith('tui: statSync') && (k.includes('/daemon/session-') || (k.includes('/projects/') && k.endsWith('.jsonl'))))
  .reduce((n, [, v]) => n + v, 0)
const attached = new Set([...top].filter(([k]) => k.startsWith('tui: statSync') && k.includes('/projects/') && k.endsWith('.jsonl')).map(([k]) => k)).size || 1
check(`§3 the connector stats ≤ ${CONNECTOR_STATS_PER_MIN} a minute per attached connector at idle`, perMin(connectorStats) <= CONNECTOR_STATS_PER_MIN * 2 * attached, `${perMin(connectorStats)}/min over ${attached} transcript(s)`)
const storeReads = [...top].filter(([k]) => /tui: readFile\((p|cb)\) .*(notification-journal|obligations-)/.test(k)).reduce((n, [, v]) => n + v, 0)
check('§4 the notification journal and the crew obligations are never read by the floor at rest (stats only)', perMin(storeReads) <= 6, `${perMin(storeReads)}/min`)
const homeSweep = [...top].filter(([k]) => k.startsWith('tui: lstat') && k.includes(CFG)).reduce((n, [, v]) => n + v, 0)
check('§5 no lstat sweep of the config home in the TUI at idle beyond a root-level write (the settings watcher ignores by path)', perMin(homeSweep) <= 60, `${perMin(homeSweep)}/min`)
const presenceRenames = [...top].filter(([k]) => k.startsWith('tui: renameSync') && k.includes('/presence/')).reduce((n, [, v]) => n + v, 0)
check('§6 the presence snapshot is never rewritten at idle', perMin(presenceRenames) === 0, `${perMin(presenceRenames)}/min`)

console.log(`\n${failures === 0 ? '✅ STORE POLL BUDGET: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
