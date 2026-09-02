#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-session-unification.ts — ONE KIND OF SESSION,
//  render-verified on the REAL built bundle through the platform's capture
//  engine (the POSIX PTY engine on POSIX, the Windows ConPTY engine on
//  win32 — one cfg grammar, one selection table in scripts/lib/captureDriver)
//  at 120x40 and 100x30 against the fixture API, in a seeded scratch home
//  whose daemon lives in that home (never the operator's):
//
//    U1  CREATE-ON-ENTER (the one-door law —
//        the retired "↵ enters the seeded blank chat" line): a direct boot
//        lands on the Boot face with NO session; ↵ on New Session BIRTHS
//        exactly one managed session (one live worker record, the composer
//        ready, no transcript yet — no words were sent);
//    U2  the first message lands in the session ↵ created: the words echo,
//        the session's runner answers through the fixture, the daemon's
//        record owns the session, the transcript carries the exchange; the
//        timing receipt (↵ → the runner's request · ↵ → the reply on
//        screen) rides the capture;
//    U3  the board shows the born session as an ordinary managed row.
//
//  Every drive runs in its OWN copy of one seeded scratch home over one
//  scratch project folder. Captures land in MERCURY_UNIFY_CAPTURE_DIR when
//  set (absolute).
// ============================================================================
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-unify-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'project')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_UNIFY_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
const KEEP = process.env.MERCURY_UNIFY_KEEP === '1'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// The driver's selection table picks the engine for THIS host (the POSIX
// PTY engine or the Windows ConPTY engine); only a host with no engine at
// all stops here. argv[0] follows the driver too: the ConPTY backend never
// searches PATH, so the Windows arm hands it the resolved node.
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') {
  console.error(`prove-session-unification: capture driver unavailable — ${driver.reason}; ${driver.remedy}`)
  process.exit(1)
}
const ENGINE = captureEngineEntry(driver, REPO)
const NODE = resolveCaptureArgv0('node', driver)
console.log(`prove-session-unification: capture engine ${driver.kind} · ${ENGINE} · ${driver.python} · node = ${NODE}`)

seedFirstRun(TEMPLATE, [CWD])

// The fixture replies name their turn so a frame is attributable. Every
// drive runs against its OWN fixture (one queue per drive, request counts
// honest per drive).
const REPLY_1 = 'The blank chat became a session. Hello from the runner.'
type FixtureApi = Awaited<ReturnType<typeof startFixtureApi>>
const BIN_UNDER_TEST = process.env.MERCURY_UNIFY_BIN ?? BIN
// MERCURY_UNIFY_MODE=timing runs only the ↵→reply timing loop (base A/B).
const MODE = process.env.MERCURY_UNIFY_MODE ?? 'full'
const TIMING_RUNS = Number(process.env.MERCURY_UNIFY_TIMING_RUNS ?? '5')

const ESC = '\x1b'
type Send = Record<string, unknown>
type Drive = {
  id: string
  cols: number
  rows: number
  argv?: string[]
  /** The whole argv (a different binary — the launcher's own splash). */
  argvWhole?: string[]
  /** Extra per-drive env (the launcher's handoff arm). */
  env?: Record<string, string>
  /** Per-drive home seeding after the template copy (the handoff receipt). */
  prepare?: (home: string) => void
  /** Runs BESIDE the capture (the process census while the drive is live). */
  during?: (home: string, rigPid: number) => Promise<void>
  sends: Send[]
  ready?: string
  total?: number
  stableTicks?: number
  turns?: Parameters<typeof startFixtureApi>[0]
  assert: (r: DriveResult) => void | Promise<void>
}
type DriveResult = {
  home: string
  text: string
  lines: string[]
  status: number
  tail: string
  payload: Record<string, unknown>
  startedAt: number
  api: FixtureApi
}

/** A strict gated send: fires only once `needle` painted (+2 settle ticks). */
function g(needle: string, data: string, extra: Send = {}): Send {
  return { requireAwait: true, awaitText: needle, awaitSettleTicks: 2, data, ...extra }
}
/** The composer's own "input is live" declaration (bracketed paste armed). */
const composerLive: Send = { atTick: 200, awaitRaw: `${ESC}[?2004h`, minTick: 30, awaitSettleTicks: 6, data: '' }
/** Every interactive boot lands on the Boot face (line 4, signed (b)); a
 *  chat is ↵ on New Session away — and under the one-door law that ↵ BIRTHS
 *  the session (the warm runner's claim keeps it instant). The base dist
 *  lands in the chat directly (MERCURY_UNIFY_BASE=1 names that door for the
 *  A/B). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const BASE_AB = process.env.MERCURY_UNIFY_BASE === '1'
const enterNewChat: Send[] =
  BASE_AB
    ? [composerLive]
    : [g(READY_LINE, '\r', { awaitSettleTicks: 4 }), g('Type a prompt', '', { awaitSettleTicks: 6 })]

const resumedSids = new Map<string, string>()
async function runDrive(drive: Drive): Promise<DriveResult> {
  const home = join(SCRATCH, `home-${drive.id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  drive.prepare?.(home)
  // A resume drive names the session its prepared home carries.
  if (drive.argv?.includes('RESUMED_SID')) {
    const sid = Object.values(readSessionWorkers(join(home, 'daemon')))[0]?.sessionId ?? transcriptsOf(home)[0]?.replace(/^.*\//, '').replace(/\.jsonl$/, '') ?? ''
    resumedSids.set(`${drive.cols}x${drive.rows}`, sid)
    drive = { ...drive, argv: drive.argv.map(a => (a === 'RESUMED_SID' ? sid : a)) }
  }
  const api = await startFixtureApi(drive.turns ?? [{ kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${drive.id}.json`)
  const outPath = join(SCRATCH, `grid-${drive.id}.json`)
  const cfg = {
    argv: drive.argvWhole ?? [NODE, BIN_UNDER_TEST, '--model', 'claude-sonnet-5', ...(drive.argv ?? [])],
    cwd: CWD,
    cols: drive.cols,
    rows: drive.rows,
    sends: drive.sends,
    ...(drive.ready !== undefined ? { readyText: drive.ready, readySettleTicks: 3 } : {}),
    ...(drive.stableTicks !== undefined ? { stableTicks: drive.stableTicks } : {}),
    total: drive.total ?? 400,
    out: outPath,
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const startedAt = Date.now()
  const child = spawn(driver.python, [ENGINE, cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      ...(drive.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The beside-the-capture hook knows the rig's pid: the screen under test
  // is the rig's pty child (the screen retitles itself `mercury`, so its
  // command line never names the bundle).
  const during = drive.during !== undefined ? drive.during(home, child.pid ?? 0).catch(() => {}) : Promise.resolve()
  const captured = new Promise<DriveResult>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        lines = grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
        if (CAPTURE_DIR) writeFileSync(join(CAPTURE_DIR, `${drive.id}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
        for (const mark of (payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []) {
          const markLines = mark.grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, ''))
          if (CAPTURE_DIR) writeFileSync(join(CAPTURE_DIR, `${drive.id}--${mark.label}.txt`), markLines.join('\n') + '\n')
        }
      } catch {
        // grid missing — the status/tail carry the reason
      }
      resolvePromise({ home, text, lines, status: status ?? 1, tail, payload, startedAt, api })
    })
  })
  const result = await captured
  await during
  return result
}

/** The ↵→reply-on-screen receipt: the send's wall clock against the
 *  readyAt tick (200 ms granularity — the rig's own clock). */
function replyLatencyMs(r: DriveResult): number | null {
  const receipts = (r.payload.sendReceipts as Array<{ atTick: number; ts: number }> | undefined) ?? []
  const sent = receipts[receipts.length - 1]
  const readyAt = r.payload.readyAt as number | null
  if (!sent || readyAt === null || readyAt === undefined) return null
  const t0 = sent.ts - sent.atTick * 200
  return t0 + readyAt * 200 - sent.ts
}

function liveRecords(home: string): ReturnType<typeof readSessionWorkers> {
  return Object.fromEntries(Object.entries(readSessionWorkers(join(home, 'daemon'))).filter(([, r]) => r.endedAt === undefined))
}

function transcriptsOf(home: string): string[] {
  const dir = join(home, 'projects')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const project of readdirSync(dir)) {
    const pdir = join(dir, project)
    // Transcripts only: the daemon writes a `<sid>.receipts.jsonl` SIDECAR
    // beside a parked session's transcript (sessionReceipts.ts — the close
    // receipt), so a successful park doubled the naive census and the
    // survives-on-disk leg failed exactly when /clear WORKED (red at base
    // in the detached control for the same reason).
    for (const f of readdirSync(pdir)) if (f.endsWith('.jsonl') && !f.endsWith('.receipts.jsonl')) out.push(join(pdir, f))
  }
  return out
}

/** Reap the drive's daemon + children so the scratch never leaks processes:
 *  the daemon self-reaps once its owner (the PTY child) is gone, but the
 *  proof ends faster than the owner-watch grace. */
async function reapHome(home: string): Promise<void> {
  for (const rec of Object.values(readSessionWorkers(join(home, 'daemon')))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
        /* gone */
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
    /* gone */
  }
}

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

// ── U1 + U2 + U3 at both sizes ──────────────────────────────────────────────
const drives: Drive[] = []
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u1-create-on-enter-${cols}x${rows}`,
    cols,
    rows,
    sends: [...enterNewChat],
    stableTicks: 8,
    total: 200,
    assert: r => {
      printFrame(`u1 ${cols}x${rows}`, r.lines)
      check(`u1 ${cols}x${rows}: the boot landed with the composer live`, r.payload.sendReceipts !== undefined, r.tail.slice(-200))
      // The poison is the retired ghost: ↵ that created nothing (zero records).
      const born = BASE_AB ? 0 : 1
      check(`u1 ${cols}x${rows}: ↵ on New Session BIRTHED exactly one session (one live worker record — born = registered)`, Object.keys(liveRecords(r.home)).length === born, JSON.stringify(Object.keys(liveRecords(r.home))))
      check(`u1 ${cols}x${rows}: the born session is blank — no transcript exists yet (no words were sent)`, transcriptsOf(r.home).length === 0, transcriptsOf(r.home).join(','))
      const daemonLog = join(r.home, 'daemon')
      check(`u1 ${cols}x${rows}: the daemon pre-warmed in the scratch home (its dir exists)`, existsSync(daemonLog), daemonLog)
    },
  })
  drives.push({
    id: `u2-first-message-${cols}x${rows}`,
    cols,
    rows,
    sends: [...enterNewChat, { afterPrevTicks: 2, data: 'hello from the boot chat', mark: 'typed' }, { afterPrevTicks: 4, data: '\r', mark: 'sent' }],
    ready: REPLY_1,
    total: 500,
    turns: [{ kind: 'text', whenModel: 'sonnet', text: REPLY_1 }, { kind: 'text', text: 'Spare.' }],
    assert: async r => {
      printFrame(`u2 ${cols}x${rows}`, r.lines)
      const live = liveRecords(r.home)
      const recs = Object.values(live)
      check(`u2 ${cols}x${rows}: the words landed in the session ↵ created — still exactly ONE managed session (one live worker record)`, recs.length === 1, JSON.stringify(recs.map(x => x.runnerId)))
      const rec = recs[0]
      check(`u2 ${cols}x${rows}: the session's runner is alive`, rec?.pid !== undefined && (() => { try { process.kill(rec.pid!, 0); return true } catch { return false } })())
      check(`u2 ${cols}x${rows}: the session runs on the model the boot chat showed`, rec?.modelKey === 'claude-sonnet-5', rec?.modelKey)
      const transcripts = transcriptsOf(r.home)
      check(`u2 ${cols}x${rows}: exactly one transcript exists — the session's own`, transcripts.length === 1 && rec !== undefined && transcripts[0]!.endsWith(`${rec.sessionId}.jsonl`), transcripts.join(','))
      const body = transcripts[0] ? readFileSync(transcripts[0], 'utf8') : ''
      check(`u2 ${cols}x${rows}: the transcript carries the words and the reply`, body.includes('hello from the boot chat') && body.includes(REPLY_1))
      check(`u2 ${cols}x${rows}: the words echo on screen`, r.text.includes('hello from the boot chat'))
      check(`u2 ${cols}x${rows}: the reply painted`, r.text.includes(REPLY_1))
      // The one transcript-home law: the session's file sits under the
      // drive's home in the project's own slug directory.
      const slug = basename(getProjectDir(CWD))
      check(`u2 ${cols}x${rows}: the transcript lives under the project's home slug (the one transcript-home law)`, transcripts[0] !== undefined && dirname(transcripts[0]) === join(r.home, 'projects', slug), `${transcripts[0]} vs ${join(r.home, 'projects', slug)}`)
      const req = r.api.messageRequests()[0]
      check(`u2 ${cols}x${rows}: the runner made exactly one model request, on the model shown`, r.api.messageRequests().length === 1 && String((req?.body as { model?: string })?.model ?? '').includes('sonnet'), `${r.api.messageRequests().length} request(s), model ${String((req?.body as { model?: string })?.model)}`)
      const ms = replyLatencyMs(r)
      console.log(`  [TIMING] u2 ${cols}x${rows}: ↵→reply-on-screen ≈ ${ms} ms (tick granularity 200 ms)`)
      await reapHome(r.home)
    },
  })
}

// ── U3: resume is the same kind (line 6) ────────────────────────────────────
// A home that already holds a session (the U2 drive's home, its daemon and
// runner gone) boots `--resume <sid>`: the transcript paints on the first
// frame from its file, the away recap rides as a display row, the daemon
// admits the SAME durable session (its record names that id), and the next
// message continues it through the fixture.
const REPLY_3 = 'Continued after the resume.'
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u3-resume-managed-${cols}x${rows}`,
    cols,
    rows,
    argv: ['--resume', 'RESUMED_SID'],
    prepare: home => {
      // The U2 drive's home carries one session: its transcript + record.
      const from = join(SCRATCH, `home-u2-first-message-${cols}x${rows}`)
      for (const sub of ['projects', 'daemon']) {
        rmSync(join(home, sub), { recursive: true, force: true })
        if (existsSync(join(from, sub))) cpSync(join(from, sub), join(home, sub), { recursive: true })
      }
      // The socket/pid of the dead daemon must not linger in the copy. (U3
      // needs U2's home: a subset run without u2 has nothing to resume.)
      if (!existsSync(join(home, 'daemon'))) throw new Error(`u3 needs the u2 drive's home (${from}) — run u2 in the same pass`)
      for (const f of readdirSync(join(home, 'daemon'))) if (!f.endsWith('.json')) rmSync(join(home, 'daemon', f), { recursive: true, force: true })
    },
    sends: [
      { atTick: 200, awaitText: 'hello from the boot chat', minTick: 5, awaitSettleTicks: 8, data: '', mark: 'first-frame' },
      { afterPrevTicks: 2, data: 'and one more thing' },
      { afterPrevTicks: 4, data: '\r' },
    ],
    ready: REPLY_3,
    total: 500,
    turns: [{ kind: 'text', whenModel: 'sonnet', text: REPLY_3 }, { kind: 'text', text: 'Spare.' }],
    assert: async r => {
      printFrame(`u3 ${cols}x${rows} (resumed, continued)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const first = (marks.find(m => m.label === 'first-frame')?.grid ?? []).map(row => row.map(c => c.c).join('')).join('\n')
      check(`u3 ${cols}x${rows}: --resume paints the transcript from its file (no menu — an explicit journey)`, first.includes('hello from the boot chat') && first.includes(REPLY_1) && !first.includes(READY_LINE))
      const sid = resumedSids.get(`${cols}x${rows}`)
      const live = Object.values(liveRecords(r.home))
      check(`u3 ${cols}x${rows}: the daemon admitted the SAME durable session (the record names its id)`, sid !== undefined && live.length === 1 && live[0]!.sessionId === sid, `${sid} vs ${JSON.stringify(live.map(x => x.sessionId))}`)
      const transcripts = transcriptsOf(r.home)
      check(`u3 ${cols}x${rows}: still ONE transcript — the session continued, none was minted`, transcripts.length === 1)
      const body = transcripts[0] ? readFileSync(transcripts[0], 'utf8') : ''
      check(`u3 ${cols}x${rows}: the next message continued the same session (both exchanges in its file)`, body.includes('hello from the boot chat') && body.includes('and one more thing') && body.includes(REPLY_3))
      check(`u3 ${cols}x${rows}: the continuation painted`, r.text.includes(REPLY_3))
      await reapHome(r.home)
    },
  })
}

// ── U4: /clear and two more of the thirteen inside the hopped-into session ──
// The born session IS a hopped-into session (one kind). /vim is a SCREEN
// command (its receipt paints on the focused chat), /counsel is a SESSION
// command (the runner's own table answers it), /clear drops the session
// (released — its row leaves the board, its transcript survives) and births
// a FRESH session for the same workspace (the one-door law: a fresh chat
// is a fresh session, on the board at birth).
const VIM_RECEIPT = 'Editor mode set to vim'
const COUNSEL_RECEIPT = 'Counsel is OFF'
// The runner's /counsel receipt is five lines; a short chat (100x30) pins
// to its LAST line, so the drive awaits the tail and the check accepts any
// line of the receipt as the runner's own answer.
const COUNSEL_RECEIPT_TAIL = 'the prompt cache'
const COUNSEL_RECEIPT_ANY = /Counsel is OFF|MERCURY_COUNSEL=|the prompt cache/
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u4-commands-in-session-${cols}x${rows}`,
    cols,
    rows,
    sends: [
      ...enterNewChat,
      { afterPrevTicks: 2, data: 'hello from the boot chat' },
      { afterPrevTicks: 4, data: '\r' },
      g(REPLY_1, '/vim', { awaitSettleTicks: 4 }),
      { afterPrevTicks: 3, data: '\r' },
      g(VIM_RECEIPT, '/counsel', { awaitSettleTicks: 4, mark: 'after-vim' }),
      { afterPrevTicks: 3, data: '\r' },
      g(COUNSEL_RECEIPT_TAIL, '/clear', { awaitSettleTicks: 4, mark: 'after-counsel' }),
      { afterPrevTicks: 3, data: '\r' },
    ],
    stableTicks: 10,
    total: 600,
    turns: [{ kind: 'text', whenModel: 'sonnet', text: REPLY_1 }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }],
    assert: async r => {
      printFrame(`u4 ${cols}x${rows} (after /clear)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const markText = (label: string): string => (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(c => c.c).join('')).join('\n')
      const afterVim = markText('after-vim')
      const afterCounsel = markText('after-counsel')
      check(`u4 ${cols}x${rows}: /vim (a screen command) painted its receipt on the focused chat`, afterVim.includes(VIM_RECEIPT), afterVim === '' ? 'no mark' : '')
      check(`u4 ${cols}x${rows}: /vim never answered "Unknown skill"`, !afterVim.includes('Unknown skill'))
      check(`u4 ${cols}x${rows}: /counsel (a session command) answered from the runner's own table`, COUNSEL_RECEIPT_ANY.test(afterCounsel), afterCounsel === '' ? 'no mark' : '')
      check(`u4 ${cols}x${rows}: /counsel never answered "Unknown skill"`, !afterCounsel.includes('Unknown skill'))
      const transcripts = transcriptsOf(r.home)
      const body = transcripts.map(t => readFileSync(t, 'utf8')).join('\n')
      check(`u4 ${cols}x${rows}: the runner recorded /counsel's receipt in the session's own transcript`, body.includes(COUNSEL_RECEIPT))
      check(`u4 ${cols}x${rows}: /vim's receipt stayed on the screen (never in the session's transcript)`, !body.includes(VIM_RECEIPT))
      // /clear: the old session PARKED ( 
      // law 1: a /clear'd chat is parked on the board, reactivatable —
      // its record stands un-ended with the park stamp) and a FRESH one
      // was born in its place — exactly one live (unparked) record, and
      // not the old id.
      const afterClear = Object.values(liveRecords(r.home)).filter(x => x.parkedAt === undefined)
      const oldRec = Object.values(readSessionWorkers(join(r.home, 'daemon'))).find(x => x.endedAt === undefined && x.parkedAt !== undefined)
      check(`u4 ${cols}x${rows}: /clear parked the old session (its record stands, parked — never ended, never crashed)`, oldRec !== undefined && oldRec.crash === undefined, JSON.stringify(Object.values(readSessionWorkers(join(r.home, 'daemon'))).map(x => [x.runnerId, x.endedAt !== undefined, x.parkedAt !== undefined])))
      check(`u4 ${cols}x${rows}: /clear birthed a fresh session (exactly one live record, a new id)`, afterClear.length === 1 && afterClear[0]?.sessionId !== oldRec?.sessionId, JSON.stringify(afterClear.map(x => x.sessionId)))
      check(`u4 ${cols}x${rows}: /clear left a fresh chat (the old rows are gone)`, !r.text.includes('hello from the boot chat') && !r.text.includes(REPLY_1))
      check(`u4 ${cols}x${rows}: the parked session's transcript survives on disk`, transcripts.length === 1 && body.includes('hello from the boot chat'))
      await reapHome(r.home)
    },
  })
}

// ── U5: hop away and back mid-turn; what a running reply looks like ────────
// A paced fixture turn streams for seconds. Mid-turn the chat is captured
// (what the screen shows of a reply in flight), /concourse takes the board
// (the boot session is an ordinary WORKING row), Tab + ↵ on the row hops
// back — the turn is still running, the composer draft survives, and the
// reply lands whole when the runner settles it.
const STREAM_WORDS = Array.from({ length: 24 }, (_, i) => `streaming-word-${String(i + 1).padStart(2, '0')} `)
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u5-hop-mid-turn-${cols}x${rows}`,
    cols,
    rows,
    sends: [
      ...enterNewChat,
      { afterPrevTicks: 2, data: 'stream a long reply please' },
      { afterPrevTicks: 4, data: '\r' },
      // The status row says the session is replying: the turn is in flight.
      // (The rig cannot drive ⇧← — the ESC-led chord class — so the hop
      // rides /concourse; a composer draft would ride along with it, so the
      // draft-survival leg is the concourse fold's capture, not this one.)
      g('· replying', '/concourse\r', { awaitSettleTicks: 8, mark: 'mid-turn-chat' }),
      g('WORKING', '\t', { awaitSettleTicks: 4, mark: 'board' }),
      { afterPrevTicks: 3, data: '\r' },
      g('⇧← back', '', { awaitSettleTicks: 3, mark: 'back' }),
    ],
    ready: 'streaming-word-24',
    total: 700,
    turns: [{ kind: 'paced', whenModel: 'sonnet', deltas: STREAM_WORDS, gapMs: 400, settleDelayMs: 800 }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }],
    assert: async r => {
      printFrame(`u5 ${cols}x${rows} (settled)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const markText = (label: string): string => (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(c => c.c).join('')).join('\n')
      const midTurn = markText('mid-turn-chat')
      const board = markText('board')
      const back = markText('back')
      check(`u5 ${cols}x${rows}: mid-turn the status row says the session is replying`, midTurn.includes('· replying'))
      const partialOnScreen = /streaming-word-0[1-9]/.test(midTurn)
      console.log(`  [PAINT] u5 ${cols}x${rows}: partial reply text visible mid-turn: ${partialOnScreen ? 'YES' : 'NO (the reply lands whole when the runner settles it)'}`)
      // The streaming reveal (line 7: painting unchanged): the reply paints
      // as it arrives — the session's live tail — not whole at the settle.
      check(`u5 ${cols}x${rows}: the reply streams on screen mid-turn (the live tail paints partial words)`, partialOnScreen)
      check(`u5 ${cols}x${rows}: the board shows the boot session as an ordinary WORKING row`, board.includes('WORKING'), board === '' ? 'no mark' : '')
      check(`u5 ${cols}x${rows}: hopping back lands in the same session mid-turn (status row + ⇧← back)`, back.includes('⇧← back') && back.includes('concourse-w1'))
      // The hopped-into chat carries the same reveal: the reply's words are
      // on screen in the chat entered from the board (mid-turn when the hop
      // beats the settle — the [PAINT] line names which frame it caught).
      const backMidTurn = back.includes('· replying')
      console.log(`  [PAINT] u5 ${cols}x${rows}: the hopped-into chat caught the reply ${backMidTurn ? 'MID-TURN (partial words + the live status row)' : 'SETTLED (the hop landed after the settle)'}`)
      check(`u5 ${cols}x${rows}: the hopped-into chat paints the reply's words (the reveal rides the hop)`, /streaming-word-\d\d/.test(back))
      check(`u5 ${cols}x${rows}: the reply settled whole in the chat after the hop`, r.text.includes('streaming-word-24') && r.text.includes('streaming-word-01'))
      // The prompt row may scroll off a short chat (100x30 keeps ~9 rows
      // under the card); it must never appear TWICE on any frame.
      const promptCount = (frame: string): number => (frame.match(/stream a long reply please/g) ?? []).length
      check(`u5 ${cols}x${rows}: no duplicated rows (the words appear at most once on every frame)`, promptCount(r.text) <= 1 && promptCount(back) <= 1 && promptCount(midTurn) <= 1, `final ${promptCount(r.text)} · back ${promptCount(back)} · mid-turn ${promptCount(midTurn)}`)
      await reapHome(r.home)
    },
  })
}

// ── U6/U7: one landing for every door (line 4, signed (b)) + the key-map row ─
// A direct `node dist/mercury.mjs` (no receipt) and a launcher handoff (the
// receipt written the way the launcher writes it, MERCURY_SPLASH_HANDOFF=1)
// both land on the Boot face: the eight-row card (the MCPs & Skills row
// joined it), the ready line, and ONE dim key-map row
// on the face's last row, outside the placed block. ↵ on New Session
// births the session and enters it (create-on-Enter).
const FACE_ROWS = ['New Session', 'Boot Menu', 'MCPs & Skills', 'Doctor / Health Check', 'Session Concourse', 'Resume Session']
// The reserved
// chat stop retires, and the key-map row paints ONLY the move that exists
// from the face — on a fresh boot with the concourse on, the concourse
// alone (no `⇧←→` chord advertising a chat that is not there).
const KEY_MAP = '⇧→ concourse'
function assertFace(id: string, r: DriveResult): void {
  for (const row of FACE_ROWS) check(`${id}: the face carries '${row}'`, r.text.includes(row))
  check(`${id}: the ready line keeps its canon bytes`, r.text.includes(READY_LINE))
  const last = r.lines[r.lines.length - 1] ?? ''
  check(`${id}: the dim key-map row sits on the face's LAST row and names the concourse alone (the strip's one present move from a fresh face)`, last.includes(KEY_MAP) && !last.includes('chat'), last.trim().slice(0, 60))
  check(`${id}: the key-map row appears exactly once, outside the card`, (r.text.match(/⇧→ concourse/g) ?? []).length === 1)
  check(`${id}: no session was created by landing on the face`, Object.keys(liveRecords(r.home)).length === 0)
}
// 120x42, not 120x40: with the eight-row card the tight head tier's block
// is exactly 40 lines, so at 120x40 the placed block fills the terminal and
// the key-map row is LAWFULLY absent (it paints only when the last row is
// free — never squeezed); two more rows keep this drive's key-map teeth
// (the placed block sits at top 1 and leaves row 42 free). The face's
// tier at 120x40 is otherwise unchanged (card · strip · head).
for (const [cols, rows] of [
  [120, 42],
  [100, 30],
] as const) {
  drives.push({
    id: `u6-direct-boot-lands-on-face-${cols}x${rows}`,
    cols,
    rows,
    sends: [g(READY_LINE, '\r', { awaitSettleTicks: 6, mark: 'face' })],
    ready: 'Type a prompt',
    total: 200,
    assert: async r => {
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const face = marks.find(m => m.label === 'face')
      const faceLines = (face?.grid ?? []).map(row => row.map(c => c.c).join(''))
      printFrame(`u6 ${cols}x${rows} (the face)`, faceLines)
      assertFace(`u6 ${cols}x${rows}`, { ...r, text: faceLines.join('\n'), lines: faceLines })
      check(`u6 ${cols}x${rows}: ↵ on New Session births the session and enters it (composer ready, ONE record — the poison is the ghost's zero)`, r.text.includes('Type a prompt') && Object.keys(liveRecords(r.home)).length === 1)
      await reapHome(r.home)
    },
  })
  drives.push({
    id: `u7-handoff-boot-lands-on-face-${cols}x${rows}`,
    cols,
    rows,
    env: { MERCURY_SPLASH_HANDOFF: '1' },
    prepare: home => {
      writeFileSync(join(home, 'splash-action.json'), JSON.stringify({ version: 1, ts: Date.now(), screen: 'held' }) + '\n')
    },
    sends: [g(READY_LINE, '', { awaitSettleTicks: 6, mark: 'face' })],
    stableTicks: 8,
    total: 200,
    assert: async r => {
      printFrame(`u7 ${cols}x${rows} (the face, handoff door)`, r.lines)
      assertFace(`u7 ${cols}x${rows}`, r)
      check(`u7 ${cols}x${rows}: the receipt was consumed by the boot`, !existsSync(join(r.home, 'splash-action.json')))
      await reapHome(r.home)
    },
  })
  drives.push({
    id: `u8-launcher-frame0-${cols}x${rows}`,
    cols,
    rows,
    argvWhole: [NODE, join(REPO, 'assets', 'splash', 'mercury-splash.mjs')],
    env: { MERCURY_SPLASH_ONESHOT: '1' },
    sends: [],
    stableTicks: 6,
    total: 60,
    assert: async r => {
      printFrame(`u8 ${cols}x${rows} (the launcher's own frame)`, r.lines)
      const last = r.lines[r.lines.length - 1] ?? ''
      check(`u8 ${cols}x${rows}: the launcher's splash carries NO key-map row (there are no screens to move between)`, !last.includes(KEY_MAP))
    },
  })
}

// ── U9: closing the terminal closes everything (line 5) ─────────────────────
// The screen's PTY child gets SIGHUP (the terminal closed on it) while a
// session runs: the owned daemon and its runner must be gone within the
// owner-watch grace, and the record must reconcile (a transcript, not a
// frame — the proof is the process census before/after).
/** The process census by `ps`: the owned daemon (`daemon <CWD>`) and the
 *  session runners (`-p … --session-id|--resume <sid>`) of this scratch. */
/** Every process of the bundle under test: the SCREEN (the rig's pty child
 *  — it retitles itself `mercury`, so it is found by parentage), the owned
 *  daemon, and the session runners (both name the bundle on their argv). */
function processCensus(rigPid = 0): { screens: number[]; daemons: number[]; runners: Array<{ pid: number; sessionId: string }> } {
  const out = { screens: [] as number[], daemons: [] as number[], runners: [] as Array<{ pid: number; sessionId: string }> }
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      const cmd = m[3]!
      if (rigPid > 0 && ppid === rigPid) {
        out.screens.push(pid)
        continue
      }
      if (!cmd.includes(BIN_UNDER_TEST)) continue
      if (cmd.includes(` daemon ${CWD}`)) {
        out.daemons.push(pid)
        continue
      }
      // A session runner is a `-p` child on the concourse wire. The id may
      // be ABSENT from argv: a warm runner boots identityless and a CLAIMED
      // one keeps that argv (its id arrived over the claim control) — the
      // census must count those processes too, or a leak would read clean.
      if (cmd.includes(' -p ') && cmd.includes('--permission-prompt-tool')) {
        const sid = /--(?:session-id|resume) ([0-9a-f-]{36})/.exec(cmd)
        out.runners.push({ pid, sessionId: sid?.[1] ?? '(claimless argv)' })
      }
    }
  } catch {
    /* no census — the checks below name it */
  }
  return out
}
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
let u9Before: ReturnType<typeof processCensus> | null = null
drives.push({
  id: 'u9-terminal-close-120x40',
  cols: 120,
  rows: 40,
  // Beside the capture: once the session's record is live, census the
  // daemon and the runner BEFORE the terminal closes on them.
  during: async (home, rigPid) => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      // The base dist (the A/B) hosts no daemon: its census is the screen
      // process alone, taken once it is up.
      const live = BASE_AB
        ? processCensus(rigPid).screens
        : Object.values(liveRecords(home)).filter(x => x.pid !== undefined && isAlive(x.pid))
      if (live.length > 0) {
        if (BASE_AB) await new Promise(res => setTimeout(res, 6000))
        u9Before = processCensus(rigPid)
        return
      }
      await new Promise(res => setTimeout(res, 250))
    }
  },
  sends: [
    ...enterNewChat,
    { afterPrevTicks: 2, data: 'stay alive for a while' },
    { afterPrevTicks: 4, data: '\r' },
    // The session is running its paced reply when the terminal closes.
    g('· replying', '', { awaitSettleTicks: 4, mark: 'before-close', signal: 'SIGHUP' }),
  ],
  total: 120,
  turns: [{ kind: 'paced', whenModel: 'sonnet', deltas: STREAM_WORDS, gapMs: 400, settleDelayMs: 800 }, { kind: 'text', text: 'Spare.' }],
  assert: async r => {
    const before = (r.payload.marks as Array<{ label: string }> | undefined)?.some(m => m.label === 'before-close') === true
    check('u9: the session was running when the terminal closed', before)
    const census = u9Before ?? { screens: [], daemons: [], runners: [] }
    const screenPids = census.screens
    const daemonPids = census.daemons
    const runnerPids = census.runners.map(x => x.pid)
    console.log(`  [CENSUS] u9: BEFORE the close — screen pid(s) ${JSON.stringify(screenPids)} · daemon pid(s) ${JSON.stringify(daemonPids)} · runner(s) ${JSON.stringify(census.runners)}`)
    if (BASE_AB) {
      check('u9 (base A/B): the census named the screen process alone — no daemon, no runner (as today)', screenPids.length >= 1 && daemonPids.length === 0 && runnerPids.length === 0)
    } else {
      // ≥1 runner: the claimed session's, plus the re-warmed unclaimed one
      // when its background pre-spawn has landed by the census moment — the
      // law is that EVERY one of them dies with the terminal.
      check('u9: the census named the screen, ONE owned daemon and the runner(s) before the close', screenPids.length >= 1 && daemonPids.length === 1 && runnerPids.length >= 1)
    }
    // The owner-watch grace: 4 s × 2 probes; the parent's SIGHUP reap is faster.
    const started = Date.now()
    const deadline = started + 20_000
    while (Date.now() < deadline && (runnerPids.some(isAlive) || daemonPids.some(isAlive) || screenPids.some(isAlive))) {
      await new Promise(res => setTimeout(res, 250))
    }
    const after = processCensus()
    console.log(`  [CENSUS] u9: AFTER the close (${((Date.now() - started) / 1000).toFixed(1)} s) — screen alive=${JSON.stringify(screenPids.map(isAlive))} · daemon alive=${JSON.stringify(daemonPids.map(isAlive))} · runners alive=${JSON.stringify(runnerPids.map(isAlive))} · ps now: screens ${JSON.stringify(after.screens)} daemons ${JSON.stringify(after.daemons)} runners ${JSON.stringify(after.runners)}`)
    check('u9: the screen died with the terminal', screenPids.length > 0 && screenPids.every(pid => !isAlive(pid)))
    if (!BASE_AB) {
      check('u9: every runner died with the terminal (the claimed session\'s and the warm one alike)', runnerPids.length > 0 && runnerPids.every(pid => !isAlive(pid)))
      check('u9: the owned daemon died with the terminal', daemonPids.length > 0 && daemonPids.every(pid => !isAlive(pid)))
      check('u9: the after-census finds no surviving runner or daemon at all', after.runners.length === 0 && after.daemons.length === 0)
    }
    const recordsAfter = readSessionWorkers(join(r.home, 'daemon'))
    const claimed = Object.values(recordsAfter).filter(x => x.endedAt === undefined && x.pid !== undefined && isAlive(x.pid))
    check('u9: no record claims a live runner after the close (the records reconciled)', claimed.length === 0)
  },
})

// ── U10: print-once under a tool-heavy turn (line 9 — "no duplicated rows") ──
// The operator's counting turn: many short assistant texts, each followed by
// a tool call a second long (text → tool_use → tool_result → text, ×N). The
// live tail must never paint a number beside its own settled row: every
// number appears AT MOST once on every mid-turn frame and EXACTLY once on the
// settled frame. On the base dist (MERCURY_UNIFY_BASE=1) this is the POISON
// leg — the boot chat there carries the settle ghost that doubles.
const COUNT_N = 8
const COUNT_WORD = (n: number): string => `count-${String(n).padStart(2, '0')}`
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u10-print-once-tool-turn-${cols}x${rows}`,
    cols,
    rows,
    sends: [
      ...enterNewChat,
      { afterPrevTicks: 2, data: `count to ${COUNT_N}, sleeping a second between` },
      { afterPrevTicks: 4, data: '\r' },
      // Ten mid-turn frames a second apart across the counting.
      ...Array.from({ length: 10 }, (_, i) => ({ afterPrevTicks: 5, data: '', mark: `frame-${i + 1}` })),
    ],
    ready: 'count-done',
    stableTicks: 6,
    total: 260,
    turns: [
      ...Array.from({ length: COUNT_N }, (_, i) => ({
        kind: 'paced_tool_use' as const,
        whenModel: 'sonnet',
        preDeltas: [`${COUNT_WORD(i + 1)} `],
        gapMs: 120,
        tools: [{ name: 'Sleep', input: { seconds: 1 } }],
      })),
      { kind: 'text' as const, whenModel: 'sonnet', text: 'count-done' },
      { kind: 'text' as const, text: 'Spare.' },
    ],
    assert: async r => {
      printFrame(`u10 ${cols}x${rows} (settled)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const frames = marks.filter(m => m.label.startsWith('frame-')).map(m => ({ label: m.label, text: m.grid.map(row => row.map(c => c.c).join('')).join('\n') }))
      const countOf = (text: string, n: number): number => (text.match(new RegExp(COUNT_WORD(n), 'g')) ?? []).length
      const doubles: string[] = []
      let seenAny = false
      for (const f of frames) {
        for (let n = 1; n <= COUNT_N; n++) {
          const c = countOf(f.text, n)
          if (c > 0) seenAny = true
          if (c > 1) doubles.push(`${f.label}:${COUNT_WORD(n)}×${c}`)
        }
      }
      console.log(`  [PRINT-ONCE] u10 ${cols}x${rows}: ${frames.length} mid-turn frames · doubles ${doubles.length === 0 ? 'NONE' : doubles.join(' ')}`)
      check(`u10 ${cols}x${rows}: the mid-turn frames caught the counting on screen`, frames.length >= 5 && seenAny)
      check(`u10 ${cols}x${rows}: every number paints AT MOST once on every mid-turn frame (no settle ghost beside its own row)`, doubles.length === 0, doubles.join(' '))
      // The settled frame: the early numbers scroll off a short chat (three
      // rows per round); whatever is on screen paints ONCE, the last number
      // and the closing reply are there.
      const settledCounts = Array.from({ length: COUNT_N }, (_, i) => countOf(r.text, i + 1))
      check(`u10 ${cols}x${rows}: the settled frame paints every visible number exactly once (the last number and the closing reply on screen)`, settledCounts.every(c => c <= 1) && settledCounts[COUNT_N - 1] === 1 && r.text.includes('count-done'), settledCounts.map((c, i) => `${COUNT_WORD(i + 1)}=${c}`).join(' '))
      await reapHome(r.home)
    },
  })
}

// ── U11: the consent card is the focused chat's (the ask wire end to end) ───
// A tool that needs consent (Write) parks the session's runner on a
// can_use_tool control request; the daemon publishes the ask; the screen
// paints the card for the FOCUSED chat; the operator's digit answers it
// through the connector's settle door; the runner proceeds and the file
// lands. One chain, no dead keypress (line 9).
for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  drives.push({
    id: `u11-consent-card-answers-${cols}x${rows}`,
    cols,
    rows,
    sends: [
      ...enterNewChat,
      { afterPrevTicks: 2, data: 'please write the file' },
      { afterPrevTicks: 4, data: '\r' },
      // The card: allow with the digit hotkey.
      { atTick: 200, awaitText: 'Do you want to', minTick: 5, awaitSettleTicks: 3, data: '1', mark: 'card' },
    ],
    ready: 'Written.',
    stableTicks: 4,
    total: 300,
    turns: [
      {
        kind: 'tool_use' as const,
        whenModel: 'sonnet',
        preText: 'Writing the file.\n',
        name: 'Write',
        input: { file_path: join(CWD, 'consent-through.txt'), content: 'approved\n' },
      },
      { kind: 'text' as const, whenModel: 'sonnet', text: 'Written.' },
      { kind: 'text' as const, text: 'Spare.' },
    ],
    assert: async r => {
      printFrame(`u11 ${cols}x${rows} (settled)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const card = (marks.find(m => m.label === 'card')?.grid ?? []).map(row => row.map(c => c.c).join('')).join('\n')
      check(`u11 ${cols}x${rows}: the consent card painted for the focused chat`, /Do you want to (create|overwrite)/.test(card) && /consent-\s*through/.test(card), card === '' ? 'no mark' : card.split('\n').filter(l => /Do you want|consent|Write/.test(l)).join(' | ').slice(0, 200))
      check(`u11 ${cols}x${rows}: the card names the session's ask (the Write tool)`, card.includes('Write') || card.includes('create'))
      const written = existsSync(join(CWD, 'consent-through.txt')) ? readFileSync(join(CWD, 'consent-through.txt'), 'utf8') : null
      check(`u11 ${cols}x${rows}: the digit answered the ask — the runner wrote the file`, written !== null && written.includes('approved'))
      check(`u11 ${cols}x${rows}: the session continued after the answer (the follow-up reply painted)`, r.text.includes('Written.'))
      check(`u11 ${cols}x${rows}: the card left the screen once answered`, !/Do you want to (create|overwrite)/.test(r.text))
      try {
        rmSync(join(CWD, 'consent-through.txt'), { force: true })
      } catch {
        /* the next drive writes its own */
      }
      await reapHome(r.home)
    },
  })
}

// ── U12: the round paints — the ask card carries the command, the RUNNING
//         card is on frame during the tool's run, the settled row follows ──
// The grid row: a managed session's tool round painted nothing
// until the settled collapse. The chat's round grammar is: the ask card
// (with the command text) → the RUNNING card (◐ · the tool · its input)
// while the tool executes → the settled row. Streaming lifecycle C2/C3.
for (const [cols, rows] of [[120, 40]] as const) {
  drives.push({
    id: `u12-round-paints-${cols}x${rows}`,
    cols,
    rows,
    sends: [
      ...enterNewChat,
      { afterPrevTicks: 2, data: 'run the bash round' },
      { afterPrevTicks: 4, data: '\r' },
      // Three frames across the safe command's 3-second run (the runner
      // boots ~1.5 s after ↵; the run spans ~2–5 s).
      { afterPrevTicks: 12, data: '', mark: 'running-1' },
      { afterPrevTicks: 6, data: '', mark: 'running-2' },
      { afterPrevTicks: 6, data: '', mark: 'running-3' },
      // The ASKING command: the card must carry the command text (C2/C3).
      { atTick: 100, awaitText: 'Round done.', minTick: 5, awaitSettleTicks: 3, data: 'now make the directory' },
      { afterPrevTicks: 3, data: '\r' },
      { atTick: 220, awaitText: 'Do you want to', minTick: 5, awaitSettleTicks: 3, data: '1', mark: 'ask-card', requireAwait: true },
    ],
    ready: 'Made it.',
    stableTicks: 4,
    total: 320,
    turns: [
      {
        kind: 'tool_use' as const,
        whenModel: 'sonnet',
        preText: 'Running it.\n',
        name: 'Bash',
        input: { command: 'sleep 3 && echo bash-round-done' },
      },
      { kind: 'text' as const, whenModel: 'sonnet', text: 'Round done.' },
      {
        kind: 'tool_use' as const,
        whenModel: 'sonnet',
        preText: 'Making it.\n',
        name: 'Bash',
        // rm is ask-class (mkdir sits on the safe list and never asks).
        input: { command: 'rm -rf ./round-made-dir' },
      },
      { kind: 'text' as const, whenModel: 'sonnet', text: 'Made it.' },
      { kind: 'text' as const, text: 'Spare.' },
    ],
    assert: async r => {
      printFrame(`u12 ${cols}x${rows} (settled)`, r.lines)
      const marks = (r.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
      const markText = (label: string): string => (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(c => c.c).join('')).join('\n')
      const ask = markText('ask-card')
      const running = [markText('running-1'), markText('running-2'), markText('running-3')]
      const runningCardOn = running.some(f => f.includes('Bash') && (f.includes('◐') || f.includes('sleep 3')))
      console.log(`  [ROUND] u12 ${cols}x${rows}: running-card frames ${running.map(f => (f.includes('Bash') ? 'CARD' : '—')).join(' · ')}`)
      check(`u12 ${cols}x${rows}: the RUNNING card is on frame while the tool executes (never a silent gap until the collapse)`, runningCardOn)
      check(`u12 ${cols}x${rows}: the ask card carries the COMMAND TEXT (lifecycle C2/C3)`, /Do you want to/.test(ask) && ask.includes('rm -rf ./round-made-dir'), ask === '' ? 'no mark' : '')
      check(`u12 ${cols}x${rows}: the settled frame carries the round's reply and the collapsed row`, r.text.includes('Made it.') && r.text.includes('Ran 1 bash command'))
      await reapHome(r.home)
    },
  })
}

// ── the line-7 timing loop: cold boot → ↵ → the reply on screen ──────────────
// Runs against BIN_UNDER_TEST (MERCURY_UNIFY_BIN) so the base dist and the
// unified dist answer the same drive; the fixture answers at once, so the
// number is the harness's own cost from ↵ to the painted reply.
const timingDrives: Drive[] = []
if (MODE === 'timing' || MODE === 'full') {
  for (let i = 1; i <= TIMING_RUNS; i++) {
    timingDrives.push({
      id: `t-first-reply-${i}`,
      cols: 120,
      rows: 40,
      sends: [...enterNewChat, { afterPrevTicks: 2, data: 'timing probe', mark: 'typed' }, { afterPrevTicks: 4, data: '\r', mark: 'sent' }],
      ready: 'Timing reply.',
      total: 400,
      turns: [{ kind: 'text', text: 'Timing reply.' }, { kind: 'text', text: 'Spare.' }],
      assert: async r => {
        await reapHome(r.home)
      },
    })
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const latencies: number[] = []
// MERCURY_UNIFY_ONLY=<id prefix>[,<id prefix>…] runs a subset of the drives.
const ONLY = (process.env.MERCURY_UNIFY_ONLY ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
for (const drive of [...(MODE === 'timing' ? [] : drives), ...timingDrives].filter(d => ONLY.length === 0 || ONLY.some(p => d.id.startsWith(p)))) {
  // POSIX signal delivery (u9's SIGHUP — the terminal closing on the screen)
  // has no ConPTY spelling: vshot-win.py parses the token and refuses loudly
  // (exit 6), so the ConPTY engine skips the leg BY NAME — the field's own
  // close-the-window leg proves that law on the Windows box.
  if (driver.kind === 'windows-conpty' && drive.sends.some(s => 'signal' in s)) {
    console.log(`\n── ${drive.id} (${drive.cols}x${drive.rows}) [SKIP] a POSIX signal send on the ConPTY engine — the field's close-the-window leg`)
    continue
  }
  const started = Date.now()
  const result = await runDrive(drive)
  console.log(`\n── ${drive.id} (${drive.cols}x${drive.rows}) ${((Date.now() - started) / 1000).toFixed(0)}s · vshot ${result.status} · ${String(result.payload.endReason)}`)
  if (result.text === '') {
    check(`${drive.id}: capture ran`, false, result.tail.slice(-300).replace(/\n/g, ' '))
    await result.api.close()
    continue
  }
  if (drive.ready !== undefined) check(`${drive.id}: reached its end state`, result.text.includes(drive.ready), result.text.includes(drive.ready) ? '' : `missing needle: ${drive.ready} · ${result.tail.slice(-200).replace(/\n/g, ' ')}`)
  await drive.assert(result)
  if (drive.id.startsWith('u1')) await reapHome(result.home)
  if (drive.id.startsWith('t-')) {
    const ms = replyLatencyMs(result)
    if (ms !== null) latencies.push(ms)
    console.log(`  [TIMING] ${drive.id}: ↵→reply-on-screen ≈ ${ms} ms`)
  }
  await result.api.close()
}
if (latencies.length > 0) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(`\n[TIMING RECEIPT] ${basename(dirname(dirname(BIN_UNDER_TEST)))}/dist: ↵→reply-on-screen over ${latencies.length} cold boots — median ${median} ms · min ${sorted[0]} ms · max ${sorted[sorted.length - 1]} ms (200 ms tick granularity)`)
}
if (!KEEP) {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    /* scratch */
  }
} else {
  console.log(`scratch kept at ${SCRATCH}`)
}
console.log(failures === 0 ? '\nprove-session-unification: ALL LAWS HOLD' : `\nprove-session-unification: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
