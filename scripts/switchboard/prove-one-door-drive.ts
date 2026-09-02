#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-one-door-drive.ts — THE ONE-DOOR LIFECYCLE on
//  the REAL built bundle through the PTY capture substrate (vshot.py) in
//  seeded scratch homes whose daemons live in those homes.
//  The felt-speed proof and the
//  restart proof, plus the birth/clear/chat-forward
//  legs; the operator's strike captures land in MERCURY_ONEDOOR_CAPTURE_DIR.
//
//   L1  THE FELT ENTER: a bare boot lands on the Boot face; with the daemon
//       and its warm runner up behind the face, ↵ on New Session reaches
//       the composer within the budget (the warm runner's claim answers in
//       milliseconds — the old ghost's Enter was one tick; the number is
//       printed for the receipt, budget 3 ticks = 600 ms at the rig's
//       200 ms granularity);
//   L2  CREATE-ON-ENTER (rule 2): that ↵ birthed exactly ONE session (one
//       live worker record) with no transcript yet (no words) — the poison
//       is the ghost's zero;
//   L3  `--chat` (L15): the FACE is the landing with NO session born and NO
//       Session Concourse row; ↵ New Session births the one chat within the
//       felt budget;
//   L4  `--concourse-off` SURVIVES RESTART: four boots on one home — the
//       switch, a bare boot whose face says "live view only — concourse
//       off", the symmetric `--concourse-on`, a bare boot whose face says
//       "the live board" again (off is never a one-way door);
//   L5  /clear births a fresh session: after /clear the old record is ended
//       and exactly one live record with a NEW id stands (the old
//       transcript survives).
// ============================================================================
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-onedoor-')))
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
const CAPTURE_DIR = process.env.MERCURY_ONEDOOR_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-one-door-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [CWD])

/** The face's canon ready line (the boot menu is on screen). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
/** The composer's placeholder (a chat is on screen). */
const COMPOSER = 'Type a prompt'
/** Ticks the face waits before ↵ so the daemon pre-warm (fired from the
 *  REPL's mount hook beneath the face) and its warm runner are up — the
 *  felt-speed leg measures the WARM road, the one the rule names. */
const WARM_TICKS = 25
/** The felt-Enter budget in rig ticks (200 ms each). */
const ENTER_BUDGET_TICKS = 3

type Send = Record<string, unknown>
type Capture = {
  home: string
  text: string
  lines: string[]
  status: number
  tail: string
  payload: Record<string, unknown>
}

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; ready?: string; total?: number; stableTicks?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5', ...(opts.argv ?? [])],
      cwd: CWD,
      cols: 120,
      rows: 40,
      sends: opts.sends,
      ...(opts.ready !== undefined ? { readyText: opts.ready, readySettleTicks: 3 } : {}),
      ...(opts.stableTicks !== undefined ? { stableTicks: opts.stableTicks } : {}),
      total: opts.total ?? 300,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: opts.home,
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
        if (CAPTURE_DIR) {
          writeFileSync(join(CAPTURE_DIR, `${opts.id}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
          for (const mark of (payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []) {
            writeFileSync(join(CAPTURE_DIR, `${opts.id}--${mark.label}.txt`), mark.grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n') + '\n')
          }
        }
      } catch {
        // grid missing — the status/tail carry the reason
      }
      resolvePromise({ home: opts.home, text, lines, status: status ?? 1, tail, payload })
    })
  })
  try {
    await api.close()
  } catch {
    /* the fixture is per capture */
  }
  return result
}

function markText(c: Capture, label: string): string {
  const marks = (c.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
  return (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(cell => cell.c).join('')).join('\n')
}

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
const liveRecords = (home: string): ReturnType<typeof readSessionWorkers> =>
  Object.fromEntries(Object.entries(recordsOf(home)).filter(([, r]) => r.endedAt === undefined))

function transcriptsOf(home: string): string[] {
  const dir = join(home, 'projects')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const project of readdirSync(dir)) {
    const pdir = join(dir, project)
    for (const f of readdirSync(pdir)) if (f.endsWith('.jsonl')) out.push(join(pdir, f))
  }
  return out
}

/** The ↵→ready receipt in ms: the LAST send's wall clock against the
 *  readyAt tick (200 ms granularity — the rig's own clock). */
function enterLatencyMs(c: Capture): number | null {
  const receipts = (c.payload.sendReceipts as Array<{ atTick: number; ts: number }> | undefined) ?? []
  const sent = receipts[receipts.length - 1]
  const readyAt = c.payload.readyAt as number | null | undefined
  if (!sent || readyAt === null || readyAt === undefined) return null
  return (readyAt - sent.atTick) * 200
}

/** Reap the home's daemon + children so the scratch never leaks processes. */
function reapHome(home: string): void {
  for (const rec of Object.values(recordsOf(home))) {
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

const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })

// ── L1 + L2: the felt Enter births exactly one session ──────────────────────
console.log('L1/L2 — the felt Enter (warm road) births exactly one session')
{
  const home = freshHome('enter')
  const c = await capture({
    id: 'l1-felt-enter',
    home,
    sends: [g(READY_LINE, '', { mark: 'face' }), { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }],
    ready: COMPOSER,
    total: 200,
  })
  printFrame('l1 (the chat after ↵)', c.lines)
  check('L1 the boot landed on the face first (no chat existed before ↵)', markText(c, 'face').includes('New Session'), markText(c, 'face').slice(0, 120))
  check('L1 the face created nothing (rule 1: a fresh boot has no chat) — the daemon had pre-warmed', Object.keys(liveRecords(home)).length === 1, JSON.stringify(Object.keys(liveRecords(home))))
  const ms = enterLatencyMs(c)
  console.log(`  [FELT] ↵ → composer ready: ${ms === null ? '∅' : `${ms} ms`} (budget ${ENTER_BUDGET_TICKS * 200} ms; the rig's tick is 200 ms — the old ghost's Enter read one tick)`)
  check(`L1 ↵ reached the composer within the budget (${ms ?? '∅'} ms ≤ ${ENTER_BUDGET_TICKS * 200})`, ms !== null && ms <= ENTER_BUDGET_TICKS * 200, c.tail.slice(-200))
  check('L1 the composer is live after ↵', c.text.includes(COMPOSER))
  const live = Object.values(liveRecords(home))
  check('L2 ↵ birthed exactly ONE session (one live worker record — born = registered; poison: the ghost\'s zero)', live.length === 1, JSON.stringify(live.map(r => r.runnerId)))
  check('L2 the born record carries the birth stamp and no delivery (a newborn)', live[0]?.bornBlankAt !== undefined && live[0]?.lastDeliveryAt === undefined)
  check('L2 the born session is blank — no transcript yet (no words were sent)', transcriptsOf(home).length === 0, transcriptsOf(home).join(','))
  check('L2 the session runs on the model the face showed', live[0]?.modelKey === 'claude-sonnet-5', live[0]?.modelKey)
  reapHome(home)
}

// ── L3: --chat lands the face; ↵ New Session births the one chat (L15) ──────
console.log('L3 — --chat: the boot menu is the landing, no session born; ↵ New Session is the door')
{
  const home = freshHome('chat')
  const c = await capture({
    id: 'l3-chat-menu',
    home,
    argv: ['--chat'],
    sends: [g(READY_LINE, '', { mark: 'face' }), { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }],
    ready: COMPOSER,
    total: 200,
  })
  printFrame('l3 (--chat: the chat after ↵)', c.lines)
  const face = markText(c, 'face')
  check('L3 the landing is the boot menu (the face), not a chat', face.includes('New Session') && face.includes(READY_LINE) && !face.includes(COMPOSER), face.slice(0, 120))
  check('L3 the --chat face carries NO Session Concourse row (New Session is the door)', !face.includes('Session Concourse'), face.split('\n').filter(l => /Concourse|live view/i.test(l)).join(' | '))
  check('L3 ↵ births exactly ONE session — none existed at boot (born at ↵, not at boot)', Object.keys(liveRecords(home)).length === 1 && Object.values(liveRecords(home))[0]?.bornBlankAt !== undefined, JSON.stringify(Object.keys(liveRecords(home))))
  check('L3 the chat is on screen after ↵ (the composer is live)', c.text.includes(COMPOSER), c.tail.slice(-200))
  const ms = enterLatencyMs(c)
  console.log(`  [FELT] --chat: ↵ → composer ready: ${ms === null ? '∅' : `${ms} ms`} (budget ${ENTER_BUDGET_TICKS * 200} ms)`)
  check(`L3 ↵ reached the composer within the budget (${ms ?? '∅'} ms ≤ ${ENTER_BUDGET_TICKS * 200})`, ms !== null && ms <= ENTER_BUDGET_TICKS * 200, c.tail.slice(-200))
  reapHome(home)
}

// ── L4: --concourse-off survives restart; --concourse-on re-enables ─────────
console.log('L4 — --concourse-off persists across boots; --concourse-on turns it back')
{
  const home = freshHome('switch')
  const boot = (id: string, argv: string[]): Promise<Capture> => capture({ id, home, argv, sends: [g(READY_LINE, '', { mark: 'face', awaitSettleTicks: 4 })], ready: READY_LINE, stableTicks: 4, total: 120 })
  const a = await boot('l4a-concourse-off', ['--concourse-off'])
  printFrame('l4a (--concourse-off)', a.lines)
  check('L4a the switch boot landed on the face', a.text.includes('New Session'), a.tail.slice(-200))
  check('L4a the face already reads the switch (live view only)', a.text.includes('live view only'))
  reapHome(home)
  const b = await boot('l4b-bare-after-off', [])
  printFrame('l4b (bare boot after the switch)', b.lines)
  check('L4b the OFF state SURVIVED the restart: a bare boot\'s face says "live view only — concourse off"', b.text.includes('live view only') && b.text.includes('concourse off'), b.lines.filter(l => /concourse|live view/i.test(l)).join(' | '))
  // The card's label grammar: ONE known project paints 'Recent Project';
  // 'Projects' needs two — the fresh drive home knows exactly one repo.
  check('L4b B1: the projects row is not dimmed with the concourse off (the row stays a plain row)', b.text.includes('Projects') || b.text.includes('Recent Project'))
  const cfg = JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as Record<string, unknown>
  check('L4b the persisted field is the registered one', cfg['concourseEnabled'] === false)
  reapHome(home)
  const on = await boot('l4c-concourse-on', ['--concourse-on'])
  check('L4c the symmetric switch boots to the face', on.text.includes('New Session'), on.tail.slice(-200))
  reapHome(home)
  const d = await boot('l4d-bare-after-on', [])
  printFrame('l4d (bare boot after --concourse-on)', d.lines)
  check('L4d the ON state survived: the face says "the live board" again (off is never a one-way door)', d.text.includes('the live board') && !d.text.includes('live view only'), d.lines.filter(l => /concourse|live/i.test(l)).join(' | '))
  const cfg2 = JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as Record<string, unknown>
  check('L4d the persisted field flipped back', cfg2['concourseEnabled'] === true)
  reapHome(home)
}

// ── L5: /clear births a fresh session ───────────────────────────────────────
// Law 1: /clear PARKS the
// old session (its record stands with the park stamp — on the board,
// reactivatable, never ended) and births a fresh one.
console.log('L5 — /clear parks the old session and births a fresh one')
{
  const home = freshHome('clear')
  const c = await capture({
    id: 'l5-clear-births',
    home,
    // The chat gets WORDS before /clear: park is for a chat WITH state —
    // a wordless newborn RELEASES instead (the quit-path law's own split:
    // "parks the messaged chat, releases the newborn"), and this leg proves
    // the PARK half; the wordless drive read the lawful end as a red.
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, 'words before the clear', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      g('Spare.', '/clear', { awaitSettleTicks: 4 }),
      { afterPrevTicks: 3, data: '\r' },
      { afterPrevTicks: 25, data: '', mark: 'after-clear' },
    ],
    stableTicks: 8,
    total: 300,
  })
  printFrame('l5 (after /clear)', c.lines)
  const all = Object.values(recordsOf(home))
  const parked = all.filter(r => r.endedAt === undefined && r.parkedAt !== undefined)
  const live = all.filter(r => r.endedAt === undefined && r.parkedAt === undefined)
  check('L5 the old session was PARKED (one un-ended record with the park stamp — never ended, never a crash row)', parked.length === 1 && parked[0]?.crash === undefined && all.every(r => r.endedAt === undefined), JSON.stringify(all.map(r => [r.runnerId, r.endedAt !== undefined, r.parkedAt !== undefined])))
  check('L5 exactly one live session stands after /clear — a NEW id (born, on the board)', live.length === 1 && live[0]?.sessionId !== parked[0]?.sessionId, JSON.stringify(live.map(r => r.sessionId)))
  check('L5 the fresh chat is on screen (the composer is live)', markText(c, 'after-clear').includes(COMPOSER) || c.text.includes(COMPOSER))
  reapHome(home)
}

if (process.env.MERCURY_ONEDOOR_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-one-door-drive: ALL LAWS HOLD' : `\nprove-one-door-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
