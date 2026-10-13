import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'tester-door-'))
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`tester door requires a PTY: ${driver.kind}`)
const python = driver.python
const door = 'https://mercury-cli.ai/report'
let failures = 0
function check(name: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}
type Grid = { c: string }[][]
type Payload = { grid: Grid; endReason: string; marks?: { label: string; grid: Grid }[] }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('').trimEnd()).join('\n')
const count = (value: string): number => value.split(door).length - 1
const enter = [
  { atTick: 100, awaitText: '↑↓ choose', minTick: 10, awaitSettleTicks: 3, requireAwait: true, data: '\r' },
  { atTick: 180, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 3, requireAwait: true, data: '' },
]
const command = (data: string) => [{ afterPrevTicks: 3, data }, { afterPrevTicks: 3, data: '\r' }]
async function drive(name: string, sends: Record<string, unknown>[], total: number, extra: Record<string, string> = {}): Promise<Payload> {
  const home = join(scratch, name, 'home')
  const project = join(scratch, name, 'project')
  mkdirSync(project, { recursive: true })
  seedFirstRun(home, [project])
  const out = join(scratch, `${name}.json`)
  const cfg = join(scratch, `${name}-cfg.json`)
  writeFileSync(cfg, JSON.stringify({ argv: ['node', join(root, 'dist/mercury.mjs')], cwd: project, cols: 120, rows: 44, sends, total, out }))
  const env = { ...process.env, VSHOT_TEE: join(scratch, `${name}.bin`), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_HEALTH_STATE_DIR: join(home, 'health'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_SKIP_PROMPT_HISTORY: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ...extra }
  const child = spawn(python, [join(root, 'scripts/ui/vshot.py'), cfg], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const rc = await new Promise<number>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 30_000))
    child.on('close', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
  writeFileSync(join(scratch, `${name}.log`), output)
  check(`${name}: capture completed`, rc === 0)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
  if (payload.endReason === 'eof') {
    const tee = readFileSync(env.VSHOT_TEE)
    const chunks: Buffer[] = []
    let offset = 0
    while (offset + 8 <= tee.length) {
      const size = tee.readUInt32BE(offset + 4)
      offset += 8
      if (offset + size > tee.length) throw new Error('Incomplete PTY read')
      chunks.push(tee.subarray(offset, offset + size))
      offset += size
    }
    const raw = Buffer.concat(chunks)
    const leave = Buffer.from('\x1b[?1049l')
    const at = raw.lastIndexOf(leave)
    check(`${name}: farewell belongs to the restored primary screen`, raw.indexOf('\x1b[?1049h') >= 0 && at > raw.indexOf('\x1b[?1049h'))
    if (at >= 0) {
      const primary = raw.subarray(at + leave.length)
      const header = Buffer.alloc(8)
      header.writeUInt32BE(primary.length, 4)
      const primaryTee = join(scratch, `${name}-primary.bin`)
      const primaryGrid = join(scratch, `${name}-primary.json`)
      writeFileSync(primaryTee, Buffer.concat([header, primary]))
      const replay = spawnSync(python, [join(root, 'scripts/ui/replay-tee-grid.py'), primaryTee, '120', '44', primaryGrid], { env, encoding: 'utf8', windowsHide: true })
      check(`${name}: primary-screen PTY replay completed`, replay.status === 0)
      if (replay.status === 0) payload.grid = (JSON.parse(readFileSync(primaryGrid, 'utf8')) as Payload).grid
    }
  }
  writeFileSync(join(scratch, `${name}-final.txt`), text(payload.grid))
  for (const mark of payload.marks ?? []) writeFileSync(join(scratch, `${name}-${mark.label}.txt`), text(mark.grid))
  if (rc !== 0) console.log(output.slice(-2500))
  return payload
}
function frame(name: string, lines: string[]): void {
  const body = `${lines.join('\n')}\n`
  const file = join(root, 'scripts/ui/fixtures/tester-door', `${name}.txt`)
  if (process.argv.includes('--record') && failures === 0) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
  } else if (!process.argv.includes('--record')) {
    try { check(`${name}: the stored frame matches`, readFileSync(file, 'utf8') === body) }
    catch { check(`${name}: the stored frame exists`, false) }
  }
}
const quiet = await drive('quiet-exit', [...enter, ...command('/exit')], 280)
const quietText = text(quiet.grid)
check('ordinary exit closes and shows the door exactly once', quiet.endReason === 'eof' && count(quietText) === 1)
frame('quiet-exit', quietText.split('\n').filter(line => /Session saved|Something broke/.test(line)).map(line => line.trim()))
const control = await drive('control-exit', [...enter, { afterPrevTicks: 3, data: '\x03' }, { atTick: 230, awaitText: 'twice to close Mercury', requireAwait: true, data: '\x03' }], 300)
const controlText = text(control.grid)
check('composer exit closes and shows the door exactly once', control.endReason === 'eof' && count(controlText) === 1)
frame('control-exit', controlText.split('\n').filter(line => line.includes('Something broke')).map(line => line.trim()))
const live = await drive('live-exit', [
  ...enter,
  { afterPrevTicks: 3, data: '!' },
  { atTick: 210, awaitText: '! Type a prompt', requireAwait: true, data: 'sleep 300' },
  { afterPrevTicks: 3, data: '\r' },
  { atTick: 280, awaitText: 'RUNS · 1 live', requireAwait: true, awaitSettleTicks: 3, data: '' },
  ...command('/exit'),
  { atTick: 380, awaitText: 'Leave Mercury?', requireAwait: true, awaitSettleTicks: 3, mark: 'first-card', data: 'n' },
  { afterPrevTicks: 6, data: '' },
  ...command('/exit'),
  { atTick: 440, awaitText: 'Leave Mercury?', requireAwait: true, awaitSettleTicks: 3, mark: 'second-card', data: 'y' },
], 520)
const first = text(live.marks?.find(mark => mark.label === 'first-card')?.grid ?? [])
const second = text(live.marks?.find(mark => mark.label === 'second-card')?.grid ?? [])
check('the first confirm card carries one door', first.includes('Leave Mercury?') && count(first) === 1)
check('staying then leaving again does not repeat the door', second.includes('Leave Mercury?') && count(second) === 0)
check('the final farewell does not repeat a door already shown', live.endReason === 'eof' && count(text(live.grid)) === 0)
frame('confirm', first.split('\n').filter(line => /Leave Mercury|quitting stops|Something broke|\[y\]/.test(line)).map(line => line.replace(/sleep \d+/g, 'sleep N').trim()))
const api = await startFixtureApi([{ kind: 'text', text: 'Short tester report' }])
try {
  const home = join(scratch, 'short-report/home')
  const report = await drive('short-report', [
    ...enter, ...command('/bug --short I tried the model picker'),
    { atTick: 240, awaitText: 'What you tried', requireAwait: true, awaitSettleTicks: 3, mark: 'tried', data: '\r' },
    { atTick: 280, awaitText: 'What broke', requireAwait: true, data: 'The picker went blank' },
    { afterPrevTicks: 3, data: '\r' },
    { atTick: 430, awaitText: 'enter to file it', requireAwait: true, awaitSettleTicks: 3, mark: 'review', data: '\x1b' },
    { afterPrevTicks: 4, data: '' }, ...command('/exit'),
  ], 520, { ANTHROPIC_BASE_URL: api.url, MERCURY_GH_CMD: JSON.stringify(['node', join(root, 'scripts/command-catalogue/fake-gh.mjs')]), GH_SHIM_LOG: join(scratch, 'short-gh.log') })
  const review = text(report.marks?.find(mark => mark.label === 'review')?.grid ?? [])
  check('short report reviews the three fields without a health dump', ['Your OS', 'What you tried', 'What broke'].every(label => review.includes(label)) && !review.includes('health --json'))
  const calls = existsSync(join(scratch, 'short-gh.log')) ? readFileSync(join(scratch, 'short-gh.log'), 'utf8') : ''
  check('the proof reached the fake GitHub CLI and filed nothing', calls.includes('auth status') && !calls.includes('issue create'))
  const { readdirSync } = await import('node:fs')
  const dir = join(home, 'feedback')
  const bodyFile = existsSync(dir) ? readdirSync(dir).find(file => file.endsWith('.md')) : undefined
  const body = bodyFile ? readFileSync(join(dir, bodyFile), 'utf8') : ''
  check('the local short draft keeps both answers and omits health and recent errors', body.includes('I tried the model picker') && body.includes('The picker went blank') && !body.includes('health --json') && !body.includes('Recent errors'))
} finally { await api.close() }
console.log(`tester door frames: ${scratch}; ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
