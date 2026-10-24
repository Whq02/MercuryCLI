#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-hook-wait-drive-')))
const HOME = join(SCRATCH, 'home')
const WORK = join(SCRATCH, 'work')
for (const dir of [HOME, join(WORK, '.mercury')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(WORK, 'README.md'), '# work\n')
{
  const run = (args: string[]): boolean => spawnSync('git', args, { cwd: WORK, stdio: 'ignore' }).status === 0
  run(['init', '-q']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'add', '.']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'])
}
process.env.MERCURY_CONFIG_DIR = HOME
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE
delete process.env.MERCURY_SKIP_PERMISSIONS
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

const REPO = join(import.meta.dir, '..', '..')
const argValue = (name: string): string | undefined => {
  const joined = process.argv.find(a => a.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const BIN = argValue('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argValue('--frames') ?? null
const KEEP = process.argv.includes('--keep')
if (FRAMES) mkdirSync(FRAMES, { recursive: true })
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first, or pass --dist <bundle>`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-hook-wait-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(HOME, [WORK])
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true } }))
const HOOK = 'slow-guard'
const HOLD_S = 6
const TIMEOUT_S = 30
writeFileSync(join(WORK, '.mercury', 'settings.json'), JSON.stringify({ events: { hooks: { 'tool.before': [{ name: HOOK, match: 'Read', run: `sleep ${HOLD_S}`, timeout: TIMEOUT_S }] } } }, null, 2))

const COLS = 178
const ROWS = 51
const READY_LINE = '↵ start  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const PROMPT = 'read the readme'
const CLOSING = 'Read it.'
const WAITING = `waiting on hook ${HOOK} · `
const readme = join(WORK, 'README.md')

type GridCell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = GridCell[][]
type Mark = { label: string; atTick: number; atMs: number; grid: Grid }
type Capture = { status: number; tail: string; grid: Grid; marks: Mark[]; endReason: string }
const rowsOf = (grid: Grid): string[] => grid.map(row => row.map(cell => (cell.c === undefined || cell.c === '' ? ' ' : cell.c)).join(''))

async function capture(): Promise<Capture> {
  const api = await startFixtureApi([
    { kind: 'tool_use', whenModel: 'opus', preText: 'Reading the readme.\n', name: 'Read', input: { file_path: readme } },
    { kind: 'text', whenModel: 'opus', text: CLOSING },
  ])
  const cfgPath = join(SCRATCH, 'cfg.json')
  const outPath = join(SCRATCH, 'grid.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      cwd: WORK,
      cols: COLS,
      rows: ROWS,
      liveSeat: true,
      sends: [
        { atTick: 120, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'face' },
        { atTick: 160, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'enter' },
        { atTick: 400, awaitText: COMPOSER, minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: PROMPT, mark: 'composer' },
        { atTick: 420, awaitText: `❯ ${PROMPT}`, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'sent' },
        { atTick: 500, awaitText: WAITING, minTick: 3, awaitSettleTicks: 6, requireAwait: true, data: '', mark: 'waiting' },
        { atTick: 600, awaitText: CLOSING, minTick: 3, awaitSettleTicks: 5, requireAwait: true, data: '', mark: 'done' },
      ],
      readyText: CLOSING,
      readySettleTicks: 5,
      total: 600,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_SPLASH: 'off',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
      MERCURY_SPECTRA_GROUND: '0',
      MERCURY_SKIP_PERMISSIONS: '1',
      MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
      MERCURY_TERMINAL_TITLE: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-1200)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-1200)))
    const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(600 * 200) + 20_000)
    child.on('close', status => {
      clearTimeout(wall)
      let grid: Grid = []
      let marks: Mark[] = []
      let endReason = 'no grid'
      try {
        const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Mark[]; endReason?: string }
        grid = payload.grid
        marks = payload.marks ?? []
        endReason = payload.endReason ?? 'unknown'
      } catch {
        grid = []
      }
      resolvePromise({ status: status ?? 1, tail, grid, marks, endReason })
    })
  })
  await api.close().catch(() => undefined)
  return result
}

function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const row of rows) console.log(`│${row.replace(/\s+$/, '')}`)
  console.log('└──')
}
const saveFrame = (name: string, rows: string[]): void => {
  if (FRAMES) writeFileSync(join(FRAMES, `${COLS}x${ROWS}-${name}.txt`), rows.map(row => row.replace(/\s+$/, '')).join('\n') + '\n')
}

console.log(`prove-hook-wait-drive: the built product at ${COLS}x${ROWS}, a tool.before hook named ${HOOK} that holds a Read for ${HOLD_S} s under a ${TIMEOUT_S} s timeout`)
const run = await capture()
const finalRows = rowsOf(run.grid)
const waiting = run.marks.find(mark => mark.label === 'waiting')
const done = run.marks.find(mark => mark.label === 'done')
printFrame(`${COLS}x${ROWS} final (end: ${run.endReason})`, finalRows)
saveFrame('final', finalRows)
if (waiting) saveFrame('waiting', rowsOf(waiting.grid))
if (done) saveFrame('done', rowsOf(done.grid))
check('the capture ran to its settled end (every send delivered)', run.status === 0 && run.grid.length === ROWS, `vshot exit ${run.status} · ${run.endReason} · ${run.tail.slice(-400)}`)
check('the turn settled (the closing text is on screen)', finalRows.some(row => row.includes(CLOSING)))
check('no consent card stood in the way (the bypass posture)', !finalRows.some(row => row.includes('Do you want to')))
check('while the hook held the Read, the screen said so: the wait mark was taken', waiting !== undefined, `marks: ${run.marks.map(mark => mark.label).join(', ')} · end: ${run.endReason}`)
if (waiting) {
  const rows = rowsOf(waiting.grid)
  const lines = rows.filter(row => row.includes(WAITING))
  const words = lines.map(row => row.slice(row.indexOf(WAITING)).replace(/\s+$/, '').replace(/\s{2,}.*$/, ''))
  check('the wait names the hook and counts the seconds against its timeout', words.length > 0 && words.every(line => new RegExp(`^${WAITING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+ s of ${TIMEOUT_S}\\b`).test(line)), JSON.stringify(words))
  const seconds = words.map(line => Number(/(\d+) s of/.exec(line)?.[1] ?? -1))
  check(`the clock reads a moment inside the hold (1..${HOLD_S + 2} s)`, seconds.length > 0 && seconds.every(s => s >= 1 && s <= HOLD_S + 2), JSON.stringify(seconds))
  check('the wait is said on the working strip (the status row the turn paints, beside its clock and token count)', lines.some(row => /\(\d+s · ↓ ~\d+\)/.test(row.slice(row.indexOf(WAITING)))), lines.map(row => row.trim().slice(0, 140)).join(' | '))
  check('the wait is also said on the Read row in the transcript, after its operation count', lines.some(row => /\d+ operations? · waiting on hook/.test(row)), `${lines.length} line(s): ${lines.map(row => row.trim().slice(0, 140)).join(' | ')}`)
}
check('the wait words leave the screen once the hook has run', done !== undefined && !rowsOf(done.grid).some(row => row.includes(WAITING)), done ? rowsOf(done.grid).filter(row => row.includes(WAITING)).join(' | ') : 'no done mark')

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-hook-wait-drive: ALL LAWS HOLD' : `prove-hook-wait-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
