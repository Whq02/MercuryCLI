#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import {
  EMPTY_REPLY_CASES_ASK,
  EMPTY_REPLY_CASES_END,
  EMPTY_REPLY_CASES_MODEL,
  casesEnv,
  startCasesFixture,
  type EmptyReplyCase,
} from './prove-empty-reply-cases.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(join(import.meta.dir, '../..'))
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const kind = (arg('--case') ?? 'silence-empty-message') as EmptyReplyCase
const cols = Number(arg('--cols') ?? 80)
const rows = Number(arg('--rows') ?? 21)
const label = arg('--label') ?? 'new'
const endText = arg('--await') ?? EMPTY_REPLY_CASES_END
const output = resolve(arg('--output') ?? join(realpathSync(tmpdir()), 'empty-reply-frames'))
mkdirSync(output, { recursive: true })
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)

const home = join(realpathSync(tmpdir()), `mercury-frames-${kind}-${label}-${process.pid}`)
rmSync(home, { recursive: true, force: true })
const cwd = join(home, 'work')
const config = join(home, 'config')
mkdirSync(cwd, { recursive: true })
mkdirSync(config, { recursive: true })
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
const { FIXTURE_API_KEY, seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
seedFirstRun(config, [cwd])
writeFileSync(join(config, 'settings.json'), '{}')
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

const fixture = await startCasesFixture(kind)
const env: NodeJS.ProcessEnv = {
  ...casesEnv(fixture.base, home, config),
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
}

const total = Number(arg('--total') ?? 300)
const cfg = {
  argv: [existsSync(node) ? node : 'node', dist, '--chat', '--model', EMPTY_REPLY_CASES_MODEL],
  cwd,
  cols,
  rows,
  out: join(output, `${kind}-${label}-${cols}x${rows}.grid.json`),
  sends: [
    { data: '', awaitText: 'New Session', requireAwait: true, minTick: 5, atTick: 100, awaitSettleTicks: 3, mark: 'boot' },
    { data: '\r', afterPrevTicks: 3 },
    { data: '', awaitText: 'ype a prompt', requireAwait: true, afterPrevTicks: 2, atTick: 160, awaitSettleTicks: 4, mark: 'ready' },
    { data: `${EMPTY_REPLY_CASES_ASK}\r`, afterPrevTicks: 8 },
    { data: '', awaitText: endText, requireAwait: false, afterPrevTicks: 2, atTick: total - 30, awaitSettleTicks: 8, mark: 'end' },
  ],
  stableTicks: 8,
  total,
}
const cfgPath = join(output, `${kind}-${label}-${cols}x${rows}.capture.json`)
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
proc.stdout.on('data', chunk => { stdout += String(chunk) })
proc.stderr.on('data', chunk => { stderr += String(chunk) })
const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(total * 200 + 30_000))
const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
clearTimeout(watchdog)
await fixture.close()
type Grid = Array<Array<{ c: string }>>
const captured = existsSync(cfg.out) ? (JSON.parse(readFileSync(cfg.out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }) : {}
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
const frame = textOf(captured.grid)
const framePath = join(output, `${kind}-${label}-${cols}x${rows}.txt`)
writeFileSync(framePath, `${frame}\n`)
const endMark = captured.marks?.find(m => m.label === 'end')
if (endMark) writeFileSync(join(output, `${kind}-${label}-${cols}x${rows}.end-mark.txt`), `${textOf(endMark.grid)}\n`)
const wire = fixture.captured.map(c => ({ n: c.n, model: c.body.model, items: Array.isArray(c.body.input) ? c.body.input.length : 0 }))
writeFileSync(join(output, `${kind}-${label}-${cols}x${rows}.wire.json`), JSON.stringify(wire, null, 2) + '\n')
writeFileSync(join(output, `${kind}-${label}-${cols}x${rows}.stderr.txt`), stderr)
console.log(JSON.stringify({ kind, label, cols, rows, exit, endReason: captured.endReason, frame: framePath, sawEnd: frame.includes(endText.slice(0, 24)), requests: wire.length, home }))
if (exit === 0) rmSync(home, { recursive: true, force: true })
process.exit(exit === 0 ? 0 : 1)
