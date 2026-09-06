#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-sovereign-doors-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const WORK = join(SCRATCH, 'work')
for (const d of [TEMPLATE, WORK]) mkdirSync(d, { recursive: true })
writeFileSync(join(WORK, 'README.md'), '# work\n')
{
  const run = (args: string[]): boolean => spawnSync('git', args, { cwd: WORK, stdio: 'ignore' }).status === 0
  run(['init', '-q']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'add', '.']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'])
}
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE
delete process.env.MERCURY_SKIP_PERMISSIONS
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_SOVEREIGN_DRIVE_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const onlyArg = process.argv.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const KEEP = process.argv.includes('--keep')

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { readSessionFacts, sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-consent-rides-every-door-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [WORK])

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const CONSENT_ACCEPT = 'Yes, I accept'
const BOARD_EMPTY = 'no sessions running'
const CONTRACT_OFFER = 'Start with a contract?'
const WARM_TICKS = 25
const SHIFT_TAB = '\x1b[Z'

type Send = Record<string, unknown>
type Capture = { home: string; text: string; lines: string[]; status: number; tail: string; payload: Record<string, unknown> }

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; total?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5', ...(opts.argv ?? [])],
      cwd: WORK,
      cols: 120,
      rows: 40,
      sends: opts.sends,
      readyText: COMPOSER,
      readySettleTicks: 3,
      total: opts.total ?? 400,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: opts.home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_SPLASH: 'off',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        lines = grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
        if (CAPTURE_DIR) {
          writeFileSync(join(CAPTURE_DIR, `${opts.id}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
          for (const mark of (payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []) {
            writeFileSync(join(CAPTURE_DIR, `${opts.id}--${mark.label}.txt`), mark.grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n') + '\n')
          }
        }
      } catch {
      }
      resolvePromise({ home: opts.home, text, lines, status: status ?? 1, tail, payload })
    })
  })
  try {
    await api.close()
  } catch {
  }
  return result
}

function markText(c: Capture, label: string): string | null {
  const marks = (c.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
  const m = marks.find(x => x.label === label)
  return m ? m.grid.map(row => row.map(cell => cell.c).join('')).join('\n') : null
}

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

const daemonDirOf = (home: string): string => join(home, 'daemon')
const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(daemonDirOf(home))
const liveRecords = (home: string): ReturnType<typeof readSessionWorkers> =>
  Object.fromEntries(Object.entries(recordsOf(home)).filter(([, r]) => r.endedAt === undefined))

function reapHome(home: string): void {
  for (const rec of Object.values(recordsOf(home))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pidFile = join(daemonDirOf(home), 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

function daemonLogLines(home: string): string[] {
  const dir = daemonDirOf(home)
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.log')) continue
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (/warm claim|spawning cold|claim refused|warm runner|permission|sovereign|dangerously/i.test(line)) out.push(`${f}: ${line.slice(0, 220)}`)
    }
  }
  return out.slice(-14)
}

async function runnerTrueMode(home: string, sessionId: string): Promise<string | null> {
  const dir = daemonDirOf(home)
  const path = sessionFactsPath(sessionId, dir)
  const before = existsSync(path) ? statSync(path).mtimeMs : -1
  process.env.MERCURY_DAEMON_DIR = dir
  try {
    await daemonControlRpc({ op: 'sessionControl', action: 'session-facts', sessionId, by: 'operator' } as never, { timeoutMs: 5_000 })
  } catch {
  } finally {
    delete process.env.MERCURY_DAEMON_DIR
  }
  const t0 = Date.now()
  while (Date.now() - t0 < 8_000) {
    if (existsSync(path) && statSync(path).mtimeMs > before) break
    await new Promise(r => setTimeout(r, 200))
  }
  return readSessionFacts(sessionId, dir)?.permissionMode ?? null
}

const BAND_RE = /\b(sovereign mode|implement mode|strategy mode|apollo mode|flow|autopilot|don't ask) on\b/
function bandModeOf(frame: string | null): string {
  if (frame === null) return '(no frame)'
  const m = BAND_RE.exec(frame)
  return m ? m[1]!.replace(' mode', '') : 'default'
}
const factsModeOf = (mode: string | null): string => (mode === 'dontAsk' ? "don't ask" : (mode ?? '(no facts)'))

const acceptConsent = (): Send[] => [
  { atTick: 90, awaitText: CONSENT_ACCEPT, minTick: 3, awaitSettleTicks: 2, data: '\x1b[B' },
  { afterPrevTicks: 2, data: '\r', mark: 'consent' },
]
const awaitFace = (first: boolean): Send => (first ? { atTick: 120, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 3, data: '', mark: 'face' } : { afterPrevTicks: 120, awaitText: READY_LINE, awaitSettleTicks: 3, data: '', mark: 'face' })
const faceDoor = (): Send[] => [{ afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }]
const boardDoor = (): Send[] => [
  { afterPrevTicks: WARM_TICKS, data: 'o', mark: 'face-o' },
  { afterPrevTicks: 40, awaitText: BOARD_EMPTY, awaitSettleTicks: 3, data: '\t', mark: 'board' },
  { afterPrevTicks: 3, data: 'n', mark: 'board-list' },
  { afterPrevTicks: 30, awaitText: CONTRACT_OFFER, awaitSettleTicks: 2, data: '\x1b', mark: 'contract' },
]
const chatAndCycle = (presses: number): Send[] => {
  const out: Send[] = [{ afterPrevTicks: 80, awaitText: COMPOSER, awaitSettleTicks: 10, data: '', mark: 'chat' }]
  for (let k = 1; k <= presses; k++) {
    out.push({ afterPrevTicks: 1, data: SHIFT_TAB })
    out.push({ afterPrevTicks: 6, data: '', mark: `st${k}` })
  }
  return out
}

type Run = { id: string; title: string; argv: string[]; row: boolean; door: 'face' | 'board'; consented: boolean; bornSovereign: boolean; presses: number }
const RUNS: Run[] = [
  { id: 'r1', title: 'the skip flag → the face → ↵ New Session', argv: ['--dangerously-bypass-permissions'], row: false, door: 'face', consented: true, bornSovereign: true, presses: 8 },
  { id: 'r2', title: 'the skip flag → the face → o → the board → tab → n → (No) → the chat', argv: ['--dangerously-bypass-permissions'], row: false, door: 'board', consented: true, bornSovereign: true, presses: 8 },
  { id: 'r3', title: 'the saved row (MERCURY_SKIP_PERMISSIONS=1) → the face → ↵ New Session', argv: [], row: true, door: 'face', consented: true, bornSovereign: true, presses: 8 },
  { id: 'r4', title: 'CONTROL — no consent → the face → ↵ New Session', argv: [], row: false, door: 'face', consented: false, bornSovereign: false, presses: 8 },
  { id: 'r5', title: 'the allow flag (consent on, default posture) → the face → ↵ New Session → the press onto Sovereign', argv: ['--allow-dangerously-bypass-permissions'], row: false, door: 'face', consented: true, bornSovereign: false, presses: 5 },
]

const counts: Record<string, { stations: string[]; distinct: number }> = {}
for (const run of RUNS) {
  if (ONLY !== null && !ONLY.has(run.id)) continue
  console.log(`\n${run.id.toUpperCase()} — ${run.title}`)
  const home = freshHome(run.id)
  if (run.row) {
    writeFileSync(join(home, 'boot-env.json'), JSON.stringify({ version: 1, savedAt: 0, env: { MERCURY_SKIP_PERMISSIONS: '1' } }, null, 2) + '\n')
  }
  const sends: Send[] = [
    ...(run.consented ? acceptConsent() : []),
    awaitFace(!run.consented),
    ...(run.door === 'face' ? faceDoor() : boardDoor()),
    ...chatAndCycle(run.presses),
  ]
  const c = await capture({ id: run.id, home, argv: run.argv, sends })
  printFrame(`${run.id} (the final frame)`, c.lines)
  for (const label of ['board', 'contract', 'chat']) {
    const f = markText(c, label)
    if (f !== null) printFrame(`${run.id} @${label}`, f.split('\n'))
  }
  const chatFrame = markText(c, 'chat')
  check(`${run.id} the chat is on screen after the door`, chatFrame !== null && chatFrame.includes(COMPOSER), c.tail.slice(-240))
  const stations = [bandModeOf(chatFrame)]
  for (let k = 1; k <= run.presses; k++) stations.push(bandModeOf(markText(c, `st${k}`)))
  const distinct = new Set(stations.filter(s => s !== '(no frame)')).size
  counts[run.id] = { stations, distinct }
  console.log(`  [STATIONS] ${run.id}: born=${stations[0]} · after each shift+tab: ${stations.slice(1).join(' → ')}`)
  console.log(`  [COUNT] ${run.id}: ${distinct} distinct station(s) across the birth + ${run.presses} presses (exit status ${c.status})`)
  const live = Object.values(liveRecords(home))
  console.log(`  [RECORDS] ${run.id}: ${live.length} live — ${JSON.stringify(live.map(r => ({ short: r.runnerId, sessionId: r.sessionId })))}`)
  const sessionId = live[0]?.sessionId
  const trueMode = sessionId !== undefined ? factsModeOf(await runnerTrueMode(home, sessionId)) : '(no session)'
  const lastBand = stations[stations.length - 1] ?? '(none)'
  console.log(`  [TRUTH] ${run.id}: the band's last station=${lastBand} · the runner's facts say=${trueMode}`)
  const log = daemonLogLines(home)
  for (const l of log) console.log(`  [DAEMON] ${l}`)
  const warmRoad = log.some(l => /warm claim acked/i.test(l)) && !log.some(l => /claim refused|claim failed|spawning cold/i.test(l))
  if (run.bornSovereign) {
    check(`${run.id} the born session RUNS sovereign (the band says so at the chat's first paint)`, stations[0] === 'sovereign', `born=${stations[0]}`)
  } else {
    check(`${run.id} the born session is not in a bypass posture (${run.consented ? 'consent on, default posture' : 'no consent'})`, stations[0] !== 'sovereign' && stations[0] !== 'autopilot', `born=${stations[0]}`)
  }
  if (run.consented) {
    check(`${run.id} the shift+tab cycle OFFERS the Sovereign station`, stations.slice(1).includes('sovereign'), stations.slice(1).join(' → '))
    if (run.presses === 5) check(`${run.id} the last press lands ON Sovereign (the band)`, lastBand === 'sovereign', stations.slice(1).join(' → '))
    check(`${run.id} the press HOLDS on the runner — its own facts agree with the band`, trueMode === lastBand, `band=${lastBand} facts=${trueMode}`)
    check(`${run.id} the consented birth lands on the WARM road (the pool's runner carries the consent — no claim refusal, no cold respawn)`, warmRoad, log.filter(l => /claim|retired/i.test(l)).join(' | ').slice(0, 300))
  } else {
    check(`${run.id} without consent Sovereign NEVER appears (born or cycled)`, !stations.includes('sovereign'), stations.join(' → '))
    check(`${run.id} without consent the runner still agrees with the band`, trueMode === lastBand, `band=${lastBand} facts=${trueMode}`)
  }
  reapHome(home)
}

if (counts.r4 !== undefined) {
  for (const id of ['r1', 'r2', 'r3', 'r5']) {
    const c = counts[id]
    if (c === undefined) continue
    check(`${id} station count = the control's + 1 (${c.distinct} vs ${counts.r4.distinct})`, c.distinct === counts.r4.distinct + 1)
  }
}
console.log(`\n[SUMMARY] ${Object.entries(counts).map(([id, c]) => `${id}=${c.distinct}`).join(' · ')}`)

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-consent-rides-every-door-drive: ALL LAWS HOLD' : `\nprove-consent-rides-every-door-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
