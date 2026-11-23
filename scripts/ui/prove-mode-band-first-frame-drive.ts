#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-mode-band-')))
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
const BIN = process.argv.find(a => a.startsWith('--dist='))?.slice('--dist='.length) ?? join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_MODE_BAND_DRIVE_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const onlyArg = process.argv.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const KEEP = process.argv.includes('--keep')
const FACTS_HOLD_MS = 2_000

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { BOOT_FACE_READY } = await import('../lib/bootFace.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { readSessionFacts, sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond && fixHint) console.log('         to change: ' + fixHint)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-mode-band-first-frame-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [WORK])

const COMPOSER = 'Type a prompt'
const CONSENT_ACCEPT = 'Yes, I accept'
const BOARD_EMPTY = 'no sessions running'
const REPLY = 'Spare.'
const WARM_TICKS = 25
const FRAMES = 24

type Send = Record<string, unknown>
type Capture = { home: string; text: string; lines: string[]; status: number; tail: string; payload: Record<string, unknown> }

function freshHome(id: string, saved?: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  if (saved !== undefined) writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: saved } }))
  return home
}

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; total?: number; env?: Record<string, string> }): Promise<Capture> {
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
      MERCURY_SESSION_FACTS_HOLD_MS: String(FACTS_HOLD_MS),
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      ...(opts.env ?? {}),
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

type Mark = { label: string; atTick: number; atMs: number; grid: Array<Array<{ c: string }>> }
function marksOf(c: Capture): Mark[] {
  return (c.payload.marks as Mark[] | undefined) ?? []
}
function markText(c: Capture, label: string): string | null {
  const m = marksOf(c).find(x => x.label === label)
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
      if (/warm claim|spawning cold|claim refused|warm runner|permission|sovereign|dangerously|revive|reactivat/i.test(line)) out.push(`${f}: ${line.slice(0, 220)}`)
    }
  }
  return out.slice(-12)
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

const BAND_RE = /\b(sovereign mode|implement mode|apollo mode|flow|don't ask) on\b/
function bandModeOf(frame: string | null): string {
  if (frame === null) return '(no frame)'
  const m = BAND_RE.exec(frame)
  return m ? m[1]!.replace(' mode', '') : 'blank'
}
const factsModeOf = (mode: string | null): string => (mode === 'dontAsk' ? "don't ask" : mode === 'default' ? 'blank' : (mode ?? '(no facts)'))

const acceptConsent = (): Send[] => [
  { atTick: 90, awaitText: CONSENT_ACCEPT, minTick: 3, awaitSettleTicks: 2, data: '\x1b[B' },
  { afterPrevTicks: 2, data: '\r', mark: 'consent' },
]
const awaitFace = (first: boolean): Send => (first ? { atTick: 120, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 3, data: '', mark: 'face' } : { afterPrevTicks: 120, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, awaitSettleTicks: 3, data: '', mark: 'face' })
const faceDoor = (): Send[] => [{ afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }]
const boardDoor = (): Send[] => [
  { afterPrevTicks: WARM_TICKS, data: 'o', mark: 'face-o' },
  { afterPrevTicks: 40, awaitText: BOARD_EMPTY, awaitSettleTicks: 3, data: '', mark: 'board' },
  { afterPrevTicks: 3, data: 'n', mark: 'board-list' },
]
const converse = (): Send[] => [
  { afterPrevTicks: 2, data: 'hi' },
  { afterPrevTicks: 2, data: '\r', mark: 'sent' },
  { afterPrevTicks: 80, awaitText: REPLY, awaitSettleTicks: 2, data: '', mark: 'reply' },
]
const frames = (first: boolean): Send[] => {
  const out: Send[] = [first ? { atTick: 200, awaitText: COMPOSER, minTick: 3, awaitSettleTicks: 0, data: '', mark: 'f00' } : { afterPrevTicks: 150, awaitText: COMPOSER, awaitSettleTicks: 0, data: '', mark: 'f00' }]
  for (let k = 1; k <= FRAMES; k++) out.push({ afterPrevTicks: 1, data: '', mark: `f${String(k).padStart(2, '0')}` })
  return out
}

type Run = {
  id: string
  title: string
  argv: (homes: Record<string, string>) => string[]
  home: (homes: Record<string, string>) => string
  door: 'face' | 'board' | 'direct'
  consented: boolean
  born: 'sovereign' | 'blank'
  typedOverSaved?: { env: Record<string, string> }
}
const COLD = { env: { MERCURY_WARM_RUNNER: '0' } }
const RUNS: Run[] = [
  { id: 'r1', title: 'the skip flag → the consent card → the face → ↵ New Session (a fresh birth)', argv: () => ['--sovereign'], home: () => freshHome('r1'), door: 'face', consented: true, born: 'sovereign' },
  { id: 'r2', title: 'CONTROL — no consent → the face → ↵ New Session (born default)', argv: () => [], home: () => freshHome('r2'), door: 'face', consented: false, born: 'blank' },
  { id: 'r3', title: 'the skip flag → the face → o → the board → tab → n → (No) → the chat (the concourse door)', argv: () => ['--sovereign'], home: () => freshHome('r3'), door: 'board', consented: true, born: 'sovereign' },
  { id: 'r4', title: "the skip flag → --continue in R1's home (its runner reaped: a cold reactivation)", argv: () => ['--sovereign', '--continue'], home: homes => homes.r1 ?? freshHome('r4'), door: 'direct', consented: true, born: 'sovereign' },
  { id: 'r5', title: "--resume <id> in R2's home (its runner reaped: the resume verb's road, born default)", argv: homes => ['--resume', sessionIdOf(homes.r2 ?? '')], home: homes => homes.r2 ?? freshHome('r5'), door: 'direct', consented: false, born: 'blank' },
  { id: 'r6', title: '--mode default over a saved flow, the warm pool off → the face → ↵ New Session (a cold birth under the typed mode)', argv: () => ['--mode', 'default'], home: () => freshHome('r6', 'flow'), door: 'face', consented: false, born: 'blank', typedOverSaved: COLD },
  { id: 'r7', title: "--mode default --continue in R6's home (its runner reaped: a cold reactivation under the typed mode)", argv: () => ['--mode', 'default', '--continue'], home: homes => homes.r6 ?? freshHome('r7', 'flow'), door: 'direct', consented: false, born: 'blank', typedOverSaved: COLD },
]
function sessionIdOf(home: string): string {
  const live = Object.values(home === '' ? {} : liveRecords(home))
  return live[0]?.sessionId ?? ''
}

const homes: Record<string, string> = {}
const summary: string[] = []
for (const run of RUNS) {
  if (ONLY !== null && !ONLY.has(run.id)) continue
  console.log(`\n${run.id.toUpperCase()} — ${run.title}`)
  const home = run.home(homes)
  homes[run.id] = home
  const argv = run.argv(homes)
  if (run.door === 'direct' && argv.includes('--resume') && argv[argv.length - 1] === '') {
    check(`${run.id} a session to resume exists in the home`, false, 'no live record in the home — the earlier run birthed nothing', 'run the earlier run (r2) in the same invocation, without --only excluding it; read its frame and DAEMON lines above to see why no session was born')
    continue
  }
  const sends: Send[] =
    run.door === 'direct'
      ? [...(run.consented ? acceptConsent() : []), ...frames(!run.consented)]
      : [...(run.consented ? acceptConsent() : []), awaitFace(!run.consented), ...(run.door === 'face' ? faceDoor() : boardDoor()), ...frames(false), ...converse()]
  const c = await capture({ id: run.id, home, argv, sends, ...(run.typedOverSaved !== undefined ? { env: run.typedOverSaved.env } : {}) })
  const first = markText(c, 'f00')
  if (first !== null) printFrame(`${run.id} @f00 (the first composer frame)`, first.split('\n'))
  printFrame(`${run.id} (the final frame)`, c.lines)
  check(`${run.id} the chat is on screen (the first composer frame was captured)`, first !== null && first.includes(COMPOSER), c.tail.slice(-240), 'the session never reached the composer: read the final frame above, and rebuild dist with bun run build.ts if dist/mercury.mjs is stale')
  if (run.door !== 'direct') {
    const reply = markText(c, 'reply')
    check(`${run.id} the conversation landed (the scripted reply is on screen — the resume roads have a transcript)`, reply !== null && reply.includes(REPLY), '', 'the scripted reply Spare. never reached the screen: read the final frame above for the stall (consent card, board, or the turn itself)')
  }
  const series: Array<{ label: string; atMs: number; mode: string }> = []
  for (const m of marksOf(c)) {
    if (!/^f\d\d$/.test(m.label)) continue
    series.push({ label: m.label, atMs: m.atMs, mode: bandModeOf(m.grid.map(row => row.map(cell => cell.c).join('')).join('\n')) })
  }
  const t0 = series[0]?.atMs ?? 0
  console.log(`  [FRAMES] ${run.id}: ${series.map(s => `${s.label}@${((s.atMs - t0) / 1000).toFixed(1)}s=${s.mode}`).join(' ')}`)
  const words = series.map(s => s.mode)
  const foreign = series.filter(s => s.mode !== run.born && s.mode !== 'blank' && s.mode !== '(no frame)')
  const firstWord = words[0] ?? '(no frame)'
  const lastWord = words[words.length - 1] ?? '(no frame)'
  const settledAt = series.find(s => s.mode === run.born)
  console.log(`  [BEATS] ${run.id}: born=${run.born} · first=${firstWord} · last=${lastWord} · foreign beats=${foreign.length}${foreign.length > 0 ? ` (${[...new Set(foreign.map(f => f.mode))].join(', ')} at ${foreign.map(f => f.label).join(',')})` : ''}${settledAt !== undefined ? ` · the born word first at ${settledAt.label} (+${((settledAt.atMs - t0) / 1000).toFixed(1)}s)` : ''}`)
  check(`${run.id} L1 no frame paints a mode word the runner never held`, foreign.length === 0, foreign.length > 0 ? `${foreign.length} foreign beat(s): ${[...new Set(foreign.map(f => f.mode))].join(', ')}` : '', 'the mode band painted a posture word other than the one the runner holds; compare the [FRAMES] and [TRUTH] lines above and make the band read the runner posture from its first frame')
  const firstMustName = run.door !== 'direct'
  check(`${run.id} L2 the first frame reads the born posture${firstMustName ? ' (a birth paints it from the first frame)' : ' or nothing'} (${run.born})`, firstWord === run.born || (!firstMustName && firstWord === 'blank'), `first=${firstWord}`, 'the first composer frame must already show the born posture word: see the [FRAMES] line above for which frame first shows it')
  check(`${run.id} L3 the last frame reads the born posture (${run.born})`, lastWord === run.born, `last=${lastWord}`, 'the band must settle on the born posture word by the last frame: see the [FRAMES] line above')
  const live = Object.values(liveRecords(home))
  const sessionId = live[0]?.sessionId
  const trueMode = sessionId !== undefined ? factsModeOf(await runnerTrueMode(home, sessionId)) : '(no session)'
  console.log(`  [TRUTH] ${run.id}: the runner's facts say=${trueMode} · records=${JSON.stringify(live.map(r => ({ short: r.runnerId, sessionId: r.sessionId, permissionMode: (r as { permissionMode?: string }).permissionMode ?? null })))}`)
  check(`${run.id} L3 the runner's own facts agree with the band's last frame`, trueMode === lastWord, `facts=${trueMode} band=${lastWord}`, 'the band disagrees with the permissionMode the runner writes in its session facts (readSessionFacts in src/services/engine-connector/seatProjections.ts); make the band follow those facts')
  if (run.typedOverSaved !== undefined) {
    check(`${run.id} L4 the runner holds the mode the launch typed, not the saved one (${run.born})`, trueMode === run.born, `facts=${trueMode}`, 'a mode typed with --mode must reach the runner over the saved guardrails.mode: routeBootJourney in src/main/interactiveLaunch.ts records that it was typed, bornSession.ts and hopIntoSession.ts in src/services/switchboard carry permissionModeTyped on sessionAdmit, and headlessPermissionArgv in src/daemon/headlessRun.ts spells --mode default for it')
  }
  for (const l of daemonLogLines(home)) console.log(`  [DAEMON] ${l}`)
  summary.push(`${run.id}: first=${firstWord} last=${lastWord} foreign=${foreign.length}`)
  reapHome(home)
}

console.log(`\n[SUMMARY] ${summary.join(' · ')}`)
if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-mode-band-first-frame-drive: ALL LAWS HOLD' : `\nprove-mode-band-first-frame-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
