#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { EMPTY_REPLY_ASK, EMPTY_REPLY_END, routeEnv, startEmptyReplyFixture } from './prove-empty-reply-note.ts'
import { REREAD_ASK, REREAD_END, startRereadFixture } from './prove-no-stagnation-governor.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(join(import.meta.dir, '../..'))
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const scene = arg('--scene') ?? 'governor'
const cols = Number(arg('--cols') ?? 80)
const rows = Number(arg('--rows') ?? 21)
const label = arg('--label') ?? 'new'
const output = resolve(arg('--output') ?? join(realpathSync(tmpdir()), 'silent-stop-frames'))
mkdirSync(output, { recursive: true })
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)

const home = join(realpathSync(tmpdir()), `mercury-frames-${scene}-${process.pid}`)
rmSync(home, { recursive: true, force: true })
const cwd = join(home, 'work')
const config = join(home, 'config')
mkdirSync(cwd, { recursive: true })
mkdirSync(config, { recursive: true })
const { FIXTURE_API_KEY, seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
seedFirstRun(config, [cwd])
writeFileSync(join(config, 'settings.json'), '{}')
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  MERCURY_CONFIG_DIR: config,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_TABULA_DIR: join(home, 'tabula'),
  MERCURY_HOME: join(home, 'product-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_AUTO_COMPACT: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
}

let env: NodeJS.ProcessEnv
let model: string
let allowed: string
let ask: string
let endText: string
let closeFixture: () => Promise<void>
let wireSummary: () => unknown
if (scene === 'governor') {
  const notes = join(cwd, 'notes.md')
  const fixture = await startRereadFixture(notes)
  env = { ...baseEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}` }
  model = 'claude-opus-4-8'
  allowed = 'Write,Read'
  ask = REREAD_ASK
  endText = REREAD_END
  closeFixture = fixture.close
  wireSummary = () => fixture.hits
} else {
  const readme = join(cwd, 'README.md')
  writeFileSync(readme, '# fixture\n')
  const fixture = await startEmptyReplyFixture(readme)
  env = { ...baseEnv, ...routeEnv(fixture.base, home, config), ANTHROPIC_API_KEY: FIXTURE_API_KEY }
  model = arg('--model') ?? 'gpt-5.6-sol'
  allowed = 'Read'
  ask = EMPTY_REPLY_ASK
  endText = EMPTY_REPLY_END
  closeFixture = fixture.close
  wireSummary = () => fixture.captured.map(c => ({ n: c.n, dialect: c.dialect, items: (Array.isArray(c.body.input) ? c.body.input : Array.isArray(c.body.messages) ? c.body.messages : []).length }))
}

const total = Number(arg('--total') ?? 300)
const cfg = {
  argv: [existsSync(node) ? node : 'node', dist, '--chat', '--model', model, '--allowed-tools', allowed],
  cwd,
  cols,
  rows,
  out: join(output, `${scene}-${label}-${cols}x${rows}.grid.json`),
  sends: [
    { data: '', awaitText: 'New Session', requireAwait: true, minTick: 5, atTick: 100, awaitSettleTicks: 3, mark: 'boot' },
    { data: '\r', afterPrevTicks: 3 },
    { data: '', awaitText: 'ype a prompt', requireAwait: true, afterPrevTicks: 2, atTick: 160, awaitSettleTicks: 4, mark: 'ready' },
    { data: `${ask}\r`, afterPrevTicks: 8 },
    { data: '', awaitText: endText, requireAwait: false, afterPrevTicks: 2, atTick: total - 30, awaitSettleTicks: 8, mark: 'end' },
  ],
  stableTicks: 8,
  total,
}
const cfgPath = join(output, `${scene}-${label}-${cols}x${rows}.capture.json`)
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
proc.stdout.on('data', chunk => { stdout += String(chunk) })
proc.stderr.on('data', chunk => { stderr += String(chunk) })
const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(total * 200 + 30_000))
const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
clearTimeout(watchdog)
await closeFixture()
type Grid = Array<Array<{ c: string }>>
const captured = existsSync(cfg.out) ? (JSON.parse(readFileSync(cfg.out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }) : {}
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
const frame = textOf(captured.grid)
const framePath = join(output, `${scene}-${label}-${cols}x${rows}.txt`)
writeFileSync(framePath, `${frame}\n`)
const endMark = captured.marks?.find(m => m.label === 'end')
if (endMark) writeFileSync(join(output, `${scene}-${label}-${cols}x${rows}.end-mark.txt`), `${textOf(endMark.grid)}\n`)
writeFileSync(join(output, `${scene}-${label}-${cols}x${rows}.wire.json`), JSON.stringify(wireSummary(), null, 2) + '\n')
writeFileSync(join(output, `${scene}-${label}-${cols}x${rows}.stderr.txt`), stderr)
console.log(JSON.stringify({ scene, label, cols, rows, exit, endReason: captured.endReason, frame: framePath, sawEnd: frame.includes(endText.slice(0, 24)), home }))
if (exit === 0) rmSync(home, { recursive: true, force: true })
process.exit(exit === 0 ? 0 : 1)
