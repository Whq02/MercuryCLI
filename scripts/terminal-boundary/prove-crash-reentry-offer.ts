#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'

const ROOT = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_CRASH_REENTRY_BIN ?? join(ROOT, 'dist/mercury.mjs')
const HARNESS = join(import.meta.dir, 'lost-terminal.py')
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-crash-reentry-'))

const CRASHED = '11111111-aaaa-4bbb-8ccc-000000000001'
const RESUMED = '22222222-aaaa-4bbb-8ccc-000000000002'
const MOVED_TO = '33333333-aaaa-4bbb-8ccc-000000000003'
const NEVER = 'deadbeef-aaaa-4bbb-8ccc-00000000dead'
const HOUR = 3_600_000

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

function transcriptRows(sessionId: string, cwd: string, word: string): string {
  const lines: Record<string, unknown>[] = []
  let prev: string | null = null
  const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId, version: '1.0.0-beta.1', gitBranch: 'main' }
  for (let n = 1; n <= 2; n++) {
    const t = String(n).padStart(3, '0')
    const u = `${sessionId.slice(0, 8)}-0000-4000-8000-${String(n * 2).padStart(12, '0')}`
    const a = `${sessionId.slice(0, 8)}-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`
    lines.push({
      ...base, parentUuid: prev, type: 'user', uuid: u,
      message: { role: 'user', content: `${word}-${t} please survey the ledger` },
      timestamp: `2026-06-19T12:00:${String(n * 2).padStart(2, '0')}.000Z`,
    })
    lines.push({
      ...base, parentUuid: u, type: 'assistant', uuid: a, requestId: `req_${word}_${t}`,
      message: {
        id: `msg_${word}_${t}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: `${word}-${t} line 01 holds steady.` }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 50 },
      },
      timestamp: `2026-06-19T12:00:${String(n * 2 + 1).padStart(2, '0')}.000Z`,
    })
    prev = a
  }
  return encodeSeedTranscript(lines, sessionId)
}

type Home = { home: string; cwd: string; projDir: string }

function seedHome(name: string): Home {
  const home = join(SCRATCH, name, 'home')
  const cwd = join(SCRATCH, name, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const projDir = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projDir, { recursive: true })
  return { home, cwd, projDir }
}

function seedTranscript(h: Home, sessionId: string, word: string, agoMs: number): string {
  const path = join(h.projDir, `${sessionId}.jsonl`)
  writeFileSync(path, transcriptRows(sessionId, h.cwd, word))
  const at = new Date(Date.now() - agoMs)
  utimesSync(path, at, at)
  return path
}

function seedReport(h: Home, report: Record<string, unknown>): void {
  const dir = join(h.home, 'crashes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `crash-${Date.now() - 5_000}-uncaught-exception.json`),
    JSON.stringify({
      origin: 'uncaught-exception',
      at: new Date(Date.now() - 5_000).toISOString(),
      message: 'read EIO',
      stack: 'Error: read EIO\n    at TTY.onStreamRead (node:internal/stream_base_commons:216:20)',
      componentStack: null,
      component: null,
      version: '1.0.0-proof',
      platform: 'proof',
      surface: 'repl',
      argv1: BIN,
      ...report,
    }, null, 2),
  )
}

type CrashRow = { file: string; origin?: string; message?: string; sessionId?: string | null; transcriptPath?: string | null; pid?: number }

function boot(h: Home, extraEnv: Record<string, string> = {}): { screen: string; crashes: CrashRow[]; exit: unknown; log: string } {
  const out = join(h.home, '..', `verdict-${Date.now()}.json`)
  const res = spawnSync('python3', [HARNESS, 'notice', BIN, h.home, h.cwd, out], {
    cwd: SCRATCH,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('MERCURY_'))),
      MERCURY_CONFIG_DIR: h.home,
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE ?? '1',
      LT_ARGV: JSON.stringify(['--resume', RESUMED]),
      LT_SETTLE_S: '7',
      LT_WAIT_EXIT_S: '30',
      ...extraEnv,
    },
  })
  try {
    const v = JSON.parse(readFileSync(out, 'utf8')) as { screen: string; crashes: CrashRow[]; exit: unknown }
    return { screen: v.screen.replace(/\s+/g, ' '), crashes: v.crashes, exit: v.exit, log: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  } catch {
    return { screen: '', crashes: [], exit: null, log: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-800) }
  }
}

const offered = (screen: string): string | null => /Resume that session/.test(screen) ? (/session ([0-9a-f]{8})/.exec(screen)?.[1] ?? '?') : null
const saysGone = (screen: string): boolean => /its transcript is gone/.test(screen)

section('§0 the artifact')
check('dist/mercury.mjs is built (this proof drives the artifact)', existsSync(BIN), BIN)
if (!existsSync(BIN)) {
  console.log('\ncrash-reentry-offer: RED (no artifact)')
  process.exit(1)
}

section('§1 the report names a session the transcript store never held, but the registry ties its pid to the transcript')
{
  const h = seedHome('registry')
  seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
  seedTranscript(h, CRASHED, 'CRASHED', 2 * HOUR)
  mkdirSync(join(h.home, 'sessions'), { recursive: true })
  writeFileSync(join(h.home, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: CRASHED, cwd: h.cwd, startedAt: Date.now() - HOUR, kind: 'interactive' }))
  seedReport(h, { sessionId: NEVER, cwd: h.cwd, pid: 4242 })
  const b = boot(h)
  check('the boot painted the crash word', /previous session crashed/.test(b.screen), b.log.slice(-400))
  check(`the dialog offers the way back into the crashed session (${CRASHED.slice(0, 8)})`, offered(b.screen) === CRASHED.slice(0, 8), `offered: ${offered(b.screen) ?? 'nothing'}; gone: ${saysGone(b.screen)}`)
  check('the transcript-is-gone words are not said', !saysGone(b.screen))
}

section('§2 the report carries no session id at all; the project holds the crashed transcript')
{
  const h = seedHome('null-id')
  seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
  seedTranscript(h, CRASHED, 'CRASHED', 2 * HOUR)
  seedReport(h, { sessionId: null, cwd: h.cwd, pid: 4243 })
  const b = boot(h)
  check('the boot painted the crash word', /previous session crashed/.test(b.screen), b.log.slice(-400))
  check(`the dialog offers the newest transcript of that project (${CRASHED.slice(0, 8)})`, offered(b.screen) === CRASHED.slice(0, 8), `offered: ${offered(b.screen) ?? 'nothing'}; gone: ${saysGone(b.screen)}`)
}

section('§3 the report carries the id a /clear moved on from; the work went on in the transcript born at the clear')
{
  const h = seedHome('cleared')
  seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
  seedTranscript(h, CRASHED, 'CLEARED', 2 * HOUR)
  const clearedAt = Date.now() - 90_000
  writeFileSync(join(h.home, 'cleared-sessions.json'), `${JSON.stringify({ [CRASHED]: clearedAt }, null, 2)}\n`)
  seedTranscript(h, MOVED_TO, 'MOVED', 0)
  seedReport(h, { sessionId: CRASHED, cwd: h.cwd, pid: 4244 })
  const b = boot(h)
  check('the boot painted the crash word', /previous session crashed/.test(b.screen), b.log.slice(-400))
  check(`the dialog offers the transcript the /clear moved the session to (${MOVED_TO.slice(0, 8)})`, offered(b.screen) === MOVED_TO.slice(0, 8), `offered: ${offered(b.screen) ?? 'nothing'}`)
}

section('§4 a report whose transcript truly does not exist still says so')
{
  const h = seedHome('gone')
  seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
  const elsewhere = join(SCRATCH, 'gone', 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  seedReport(h, { sessionId: NEVER, cwd: elsewhere, pid: 4245 })
  const b = boot(h)
  check('the boot painted the crash word', /previous session crashed/.test(b.screen), b.log.slice(-400))
  check('no dialog is offered', offered(b.screen) === null, `offered: ${offered(b.screen)}`)
  check('the notice says the transcript is gone', saysGone(b.screen), b.screen.slice(0, 300))
}

section('§5 a crash inside a chat records the chat itself: its id and its transcript; the next boot into it says so')
{
  const h = seedHome('identity')
  const resumedPath = seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
  const crashed = boot(h, { MERCURY_RENDER_FAULT: 'message', LT_COLS: '220' })
  const report = crashed.crashes.find(c => c.origin === 'message-boundary')
  check('the injected render fault left a message-boundary report', report !== undefined, JSON.stringify(crashed.crashes))
  check(`the report names the chat the operator was in (${RESUMED.slice(0, 8)}), not the window's own id`, report?.sessionId === RESUMED, `sessionId: ${report?.sessionId}`)
  check("the report records the chat's transcript path", report?.transcriptPath === resumedPath, `transcriptPath: ${report?.transcriptPath}`)
  const at = crashed.screen.indexOf('previous session crashed')
  check('the notice inside that very chat says it is back in, offering no second door', /this is that session, back in/.test(crashed.screen) && offered(crashed.screen) === null, crashed.screen.slice(Math.max(0, at - 20), at + 260))
}

section('§6 the resolver, road by road')
{
  const mod = (await import('../../src/utils/crashReport.ts')) as Record<string, unknown>
  const resolve = mod.resolveCrashTranscript as
    | ((report: Record<string, unknown>, opts: Record<string, unknown>) => { sessionId: string; transcriptPath: string; road: string } | null)
    | undefined
  check('the crash report module resolves a transcript by every identity a report carries', typeof resolve === 'function')
  if (typeof resolve === 'function') {
    const h = seedHome('resolver')
    const older = seedTranscript(h, RESUMED, 'OLDER', 3 * HOUR)
    const crashed = seedTranscript(h, CRASHED, 'CRASHED', 2 * HOUR)
    const projectDirOf = (cwd: string): string => join(h.home, 'projects', sanitizePath(cwd))
    const opts = { projectDirOf, currentCwd: h.cwd, sessionsDir: join(h.home, 'sessions'), clearedAt: () => null }
    const recorded = resolve({ sessionId: CRASHED, cwd: h.cwd, pid: 1, transcriptPath: crashed }, opts)
    check('a recorded transcript path wins', recorded?.road === 'recorded' && recorded.transcriptPath === crashed, JSON.stringify(recorded))
    const byId = resolve({ sessionId: CRASHED, cwd: h.cwd, pid: 1, transcriptPath: join(h.home, 'nowhere.jsonl') }, opts)
    check('a gone recorded path falls back to the id in the project', byId?.road === 'report' && byId.transcriptPath === crashed, JSON.stringify(byId))
    mkdirSync(join(h.home, 'sessions'), { recursive: true })
    writeFileSync(join(h.home, 'sessions', '77.json'), JSON.stringify({ pid: 77, sessionId: RESUMED, cwd: h.cwd }))
    const byPid = resolve({ sessionId: NEVER, cwd: h.cwd, pid: 77, transcriptPath: null }, opts)
    check('the registry ties a pid to its transcript ahead of the newest-of-project road', byPid?.road === 'registry' && byPid.transcriptPath === older, JSON.stringify(byPid))
    const newest = resolve({ sessionId: NEVER, cwd: h.cwd, pid: 78, transcriptPath: null }, opts)
    check('the newest transcript of the project is the last road', newest?.road === 'project' && newest.transcriptPath === crashed, JSON.stringify(newest))
    const bornLater = resolve({ sessionId: null, cwd: h.cwd, pid: null, transcriptPath: null }, { ...opts, notAfterMs: Date.now() - 4 * HOUR })
    check('a transcript born after the boot is never offered', bornLater === null, JSON.stringify(bornLater))
    const elsewhere = join(SCRATCH, 'resolver', 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const otherProject = resolve({ sessionId: null, cwd: elsewhere, pid: null, transcriptPath: null }, opts)
    check("the newest-of-project road reads the crash's own project, never the current one", otherProject === null, JSON.stringify(otherProject))
    const moved = resolve({ sessionId: RESUMED, cwd: h.cwd, pid: null, transcriptPath: null }, { ...opts, clearedAt: () => Date.now() - 150 * 60_000 })
    check('a cleared id moves to the transcript born at the clear', moved?.road === 'moved' && moved.transcriptPath === crashed, JSON.stringify(moved))
    const clearedAlone = resolve({ sessionId: CRASHED, cwd: h.cwd, pid: null, transcriptPath: null }, { ...opts, clearedAt: () => Date.now() - 60_000 })
    check('a cleared id with nothing born after the clear still offers its own transcript', clearedAlone?.road === 'report' && clearedAlone.transcriptPath === crashed, JSON.stringify(clearedAlone))
    const excluded = resolve({ sessionId: CRASHED, cwd: h.cwd, pid: null, transcriptPath: crashed }, { ...opts, excludeSessionIds: [CRASHED] })
    check('an excluded id is passed over on every road', excluded?.sessionId === RESUMED, JSON.stringify(excluded))
    const beforeCrash = resolve({ sessionId: null, cwd: h.cwd, pid: null, transcriptPath: null, at: new Date(Date.now() - 150 * 60_000).toISOString() }, opts)
    check('the newest-of-project road never offers a session born after the crash', beforeCrash?.transcriptPath === older, JSON.stringify(beforeCrash))
    const movedTo = seedTranscript(h, MOVED_TO, 'MOVED', HOUR)
    const clearedTimes: Record<string, number> = { [RESUMED]: Date.now() - 150 * 60_000, [CRASHED]: Date.now() - 100 * 60_000 }
    const chained = resolve({ sessionId: RESUMED, cwd: h.cwd, pid: null, transcriptPath: null }, { ...opts, clearedAt: (id: string) => clearedTimes[id] ?? null })
    check('a chain of /clear moves is followed to the transcript the work ended in', chained?.road === 'moved' && chained.transcriptPath === movedTo, JSON.stringify(chained))
  }
}

if (failures > 0) {
  console.log(`\ncrash-reentry-offer: RED (${failures} failed) — scratch kept at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\ncrash-reentry-offer: green')
process.exit(0)
