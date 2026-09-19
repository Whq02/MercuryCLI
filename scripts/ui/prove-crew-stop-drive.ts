#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { LEAD_ASK_MATE, LEAD_ASK_SLEEPER, MATE_NAME, SEAT_NAME, startCrewStopFixture, type Fixture } from '../crew/crew-stop-fixture.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const LEGS = (argAfter('--legs') ?? 'mate,card,tasks,sleeper').split(',')
const SIZES = (argAfter('--sizes') ?? '120x40').split(',').map(s => s.split('x').map(Number) as [number, number])
const KEEP = process.argv.includes('--keep')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first, or name a bundle with --dist`)
  process.exit(0)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; sends: number; receipts: number; endReason: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'crew-stop-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), marks, sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '' }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-stop-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-stop-cwd-')))
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_CONNECTOR_TRACE: join(home, 'connector-trace.jsonl'),
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
    BROWSER: '/usr/bin/true',
  }
  for (const stamp of ['MERCURY_TEAMMATES', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_DAEMON_CREW', 'MERCURY_CREW', 'NODE_ENV', 'CI']) delete process.env[stamp]
  return env
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

const STATE_WORDS = /\b(running|stopped|landed|failed|paused|waiting)\b|Sleeping for/
const rowOf = (text: string, name: string): string | undefined => {
  const lines = text.split('\n').filter(line => line.includes(name) && STATE_WORDS.test(line) && !line.includes('crew-stop:'))
  return lines.find(line => /[▸►]/.test(line)) ?? lines.find(line => /[◐✗●○]/.test(line)) ?? lines[0]
}
const flat = (s: string): string => s.replace(/\s+/g, ' ')

function keep(label: string, frame: string | undefined): void {
  if (FRAMES === undefined || frame === undefined) return
  writeFileSync(join(FRAMES, `${label}.txt`), frame + '\n')
}

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

function recordsOf(home: string): { daemonStops: string[] } {
  const daemonLog = join(home, 'daemon', 'daemon.log')
  const daemonStops = existsSync(daemonLog) ? readFileSync(daemonLog, 'utf8').split('\n').filter(l => l.includes('stop-agent')) : []
  return { daemonStops }
}

async function leg(name: string, cols: number, rows: number): Promise<void> {
  const tag = `${name} ${cols}x${rows}`
  console.log(`\n— ${tag} —`)
  const before = failures
  const seat = name === 'sleeper'
  const fixture: Fixture = await startCrewStopFixture({ seatTool: 'sleep' })
  const { home, cwd } = seedWorld()
  const target = seat ? SEAT_NAME : MATE_NAME
  const ask = seat ? LEAD_ASK_SLEEPER : LEAD_ASK_MATE
  const openView = name === 'tasks' ? '/tasks' : '/teammates'
  const listGate = name === 'tasks' ? target : '1 running'
  const sends: Array<Record<string, unknown>> = [
    ...bootSends(ask),
    { data: openView, atTick: 999, awaitText: target, requireAwait: true, minTick: 5, awaitSettleTicks: 4 },
    { data: '\r', afterPrevTicks: 4 },
    ...(name === 'card'
      ? [
          { data: '\r', atTick: 999, awaitText: listGate, requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-running' },
          { data: 'x', atTick: 999, awaitText: 'esc back', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'card-running' },
        ]
      : [{ data: 'x', atTick: 999, awaitText: listGate, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'crew-running' }]),
    { data: 'x', atTick: 999, awaitText: 'x again within', requireAwait: true, minTick: 1, awaitSettleTicks: 1, mark: 'armed' },
    { data: '\x1b', afterPrevTicks: 7, mark: 'crew-after' },
    ...(name === 'card' ? [{ data: '\x1b', afterPrevTicks: 3, mark: 'list-after' }] : []),
    { data: openView, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
    { data: '\r', afterPrevTicks: 4 },
    { data: '\x1b', atTick: 999, awaitText: name === 'tasks' ? 'esc' : 'Sub-agents', requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'crew-later' },
  ]
  let cap: Capture | null = null
  try {
    cap = await capture({ cols, rows, total: 500, cwd, argv: ['node', DIST], sends, stableTicks: 6 }, driveEnv(home, fixture.base))
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const records = recordsOf(home)
  const size = `${cols}x${rows}`
  for (const [label, frame] of Object.entries(marks)) keep(`${name}-${size}-${label}`, frame)
  if (FRAMES !== undefined) writeFileSync(join(FRAMES, `${name}-${size}-records.txt`), [`daemon stop-agent lines: ${records.daemonStops.length}`, ...records.daemonStops, '', `fixture routes: ${fixture.hits.map(h => `${h.route}${h.step ? `#${h.step}` : ''}`).join(',')}`].join('\n') + '\n')
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const running = marks['crew-running'] ?? ''
  const runningRow = rowOf(running, target)
  check(`${tag}: the row runs before the chord`, runningRow !== undefined && /\brunning\b|◐|Sleeping/.test(runningRow), runningRow ?? '(no row)')
  const armed = marks['armed'] ?? ''
  check(`${tag}: the first x arms the chord and names the row`, armed.includes(`x again within 2 s stops ${target}`) || flat(armed).includes('x again within 2 s stops'), flat(armed).slice(0, 200))
  const after = marks['crew-after'] ?? ''
  const afterRow = rowOf(after, target)
  check(`${tag}: after x x the row reads stopped, never running`, afterRow !== undefined && /\bstopped\b/.test(afterRow) && !/\brunning\b/.test(afterRow), afterRow ?? '(no row)')
  check(`${tag}: no refusal is painted under the rows`, !after.includes('was refused'), flat(after).slice(0, 200))
  check(`${tag}: the daemon relayed exactly one stop to the runner (the chord fired once, the connector sent it once)`, records.daemonStops.length === 1, `daemon lines ${records.daemonStops.length}`)
  const later = marks['crew-later'] ?? ''
  const laterRow = rowOf(later, target)
  check(`${tag}: the row never returns to running`, laterRow === undefined || !/\brunning\b/.test(laterRow), laterRow ?? '(row gone)')
  if (failures > before || process.env.CREW_STOP_KEEP === '1') {
    for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
    for (const line of records.daemonStops) console.log(`  [daemon] ${line}`)
    console.log(`  [fixture] ${fixture.hits.map(h => `${h.route}${h.step ? `#${h.step}` : ''}`).join(',')}`)
  }
  if (KEEP) console.log(`  [keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`bundle: ${DIST}`)
for (const name of LEGS) for (const [cols, rows] of SIZES) await leg(name, cols, rows)
console.log(failures === 0 ? '\nprove-crew-stop-drive: ALL LAWS HOLD' : `\nprove-crew-stop-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
