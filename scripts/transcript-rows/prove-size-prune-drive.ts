#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(arg('--root') ?? join(import.meta.dir, '../..'))
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const output = resolve(arg('--output') ?? mkdtempSync(join(tmpdir(), 'size-prune-frames-')))
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(output, 'world-'))
const cwd = join(home, 'work')
const config = join(home, 'config')
mkdirSync(cwd)
mkdirSync(config)
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(home, 'teams')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const { seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
const { encodeSeedTranscript } = await import(join(root, 'scripts/lib/seedTranscript.ts'))
const { sanitizePath } = await import(join(root, 'src/utils/sessionStoragePortable.ts'))
const { resolveCaptureDriver, captureEngineEntry, vshotBudgetMs } = await import(join(root, 'scripts/lib/captureDriver.ts'))
const { startOverflowFixture } = await import(join(root, 'scripts/compact/overflowFixture.ts'))
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const fixture = await startOverflowFixture()
fixture.inputRule = true
fixture.script(() => ({ text: 'The work can continue.', usage: { input: 60000, output: 6 } }))
seedFirstRun(config, [cwd])
writeFileSync(join(config, 'settings.json'), '{}')
const sid = randomUUID()
const timestamp = new Date().toISOString()
const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId: sid, version: '1.0.0', gitBranch: 'main', timestamp }
const rows: Array<Record<string, unknown>> = []
let parentUuid: string | null = null
const add = (row: Record<string, unknown>): void => {
  const uuid = randomUUID()
  rows.push({ ...base, ...row, uuid, parentUuid })
  parentUuid = uuid
}
add({ type: 'user', message: { role: 'user', content: 'Read the changing file and keep its latest contents.' } })
for (let i = 0; i < 16; i++) {
  add({ type: 'assistant', message: { id: `read-message-${i}`, role: 'assistant', type: 'message', model: 'gpt-5.6-sol', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10000 + i * 10000, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: join(cwd, 'notes.txt') } }] } })
  add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: `revision ${i}\n${'the current file contents remain available for the next step.\n'.repeat(650)}` }] } })
}
add({ type: 'assistant', message: { id: 'ready-message', role: 'assistant', type: 'message', model: 'gpt-5.6-sol', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 165000, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'The latest file is ready.' }] } })
const project = join(config, 'projects', sanitizePath(cwd))
mkdirSync(project, { recursive: true })
writeFileSync(join(project, `${sid}.jsonl`), encodeSeedTranscript(rows, sid))
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: tmpdir(),
  TMP: tmpdir(),
  TEMP: tmpdir(),
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  ...fixture.env,
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
  MERCURY_PRUNE_PCT: '40',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
}
delete env.ANTHROPIC_AUTH_TOKEN
const cols = Number(arg('--cols') ?? 80)
const height = Number(arg('--rows') ?? 21)
const cfg = {
  argv: [existsSync(node) ? node : 'node', dist, '--resume', sid, '--model', 'gpt-5.6-sol'],
  cwd,
  cols,
  rows: height,
  out: join(output, 'grid.json'),
  sends: [
    { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 5, atTick: 100, awaitSettleTicks: 4, mark: 'ready' },
    { data: 'Continue.\r', afterPrevTicks: 8 },
    { data: '', awaitText: 'context size', requireAwait: true, afterPrevTicks: 2, atTick: 180, awaitSettleTicks: 5, mark: 'receipt' },
  ],
  stableTicks: 5,
  total: 200,
}
const cfgPath = join(output, 'capture.json')
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
proc.stdout.on('data', chunk => { stdout += String(chunk) })
proc.stderr.on('data', chunk => { stderr += String(chunk) })
const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(60000))
const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
clearTimeout(watchdog)
await fixture.close()
writeFileSync(join(output, 'capture.stdout.txt'), stdout)
writeFileSync(join(output, 'capture.stderr.txt'), stderr)
writeFileSync(join(output, 'wire.json'), JSON.stringify(fixture.captured, null, 2) + '\n')
const captured = existsSync(cfg.out) ? JSON.parse(readFileSync(cfg.out, 'utf8')) as { marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> } : {}
const receipt = captured.marks?.find(mark => mark.label === 'receipt')
const text = receipt?.grid.map(row => row.map(cell => cell.c).join('')).join(' ').replace(/\s+/g, ' ') ?? ''
const mainRequest = fixture.captured.find(request => request.dialect === 'responses')
const results = (mainRequest?.body.input as Array<{ type?: string; output?: string }> | undefined)?.filter(item => item.type === 'function_call_output') ?? []
const success = exit === 0 && text.includes('context size') && text.includes('prune threshold 40%') && text.includes('pruned 11') && text.includes('superseded tool results') && results.length === 16 && results.filter(item => item.output?.startsWith('[stale tool result')).length === 11 && fixture.refusals.length === 0
console.log(`[${success ? 'PASS' : 'FAIL'}] the real chat displays the proactive-prune receipt at ${cols}x${height}`)
console.log(JSON.stringify({ exit, requests: fixture.captured.length, home, output, marks: captured.marks?.map(mark => mark.label), stderr }))
process.exit(success ? 0 : 1)
