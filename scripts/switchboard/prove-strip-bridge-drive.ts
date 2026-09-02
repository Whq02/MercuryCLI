#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-strip-bridge-drive.ts — THE STRIP AND THE
//  BRIDGE on the REAL built bundle through the PTY capture substrate
//  (vshot.py) in seeded scratch homes whose daemons live in those homes.
//  The operator's
//  strike captures land in MERCURY_STRIP_CAPTURE_DIR.
//
//  THE LAW: shift+←/→ only ever move between screens that exist. The
//  reserved chat stop retires — a strip that always counted three stops
//  rubber-banded a bare boot off the empty REPL and onto the boot menu.
//
//   S1  A BARE BOOT HAS TWO STOPS: the face (its key-map row names the
//       concourse alone) → ⇧→ lands the concourse → ⇧→ again is NO
//       MOVEMENT: the frame before and after the second ⇧→ are byte-
//       identical (no bounce, no flash, no empty chat, no boot menu); no
//       session was created by walking.
//   S2  THE STOP APPEARS: ↵ on New Session births the chat; ⇧← is the
//       board, ⇧→ re-enters the same chat, ⇧← ⇧← reaches the face, whose
//       row still names the concourse (the next stop to the right).
//   S3  THE STOP VANISHES: the last chat closed from the board (the
//       double-x release) lands the boot menu (rule 5); ⇧→ is the board
//       again and ⇧→ again is no movement (byte-still) — the chat stop is
//       gone with the session.
//   S4  `--chat` IS THE PLAIN WORLD (L15): the boot menu is the landing —
//       no session born, no Session Concourse row, its key-map row "⇧→ no
//       chat open"; ↵ births the chat; ⇧← is the boot menu DIRECTLY (no
//       concourse between), whose row now names the chat; ⇧← again is the
//       silent end (byte-still); ⇧→ is the chat.
//   S5  `--concourse-off` IS THE SAME WORLD: the switch boot lands the
//       face ("live view only"); ↵ births the chat; ⇧← is the face
//       directly (no live view on the strip); ⇧→ is the chat.
// ============================================================================
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-strip-')))
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
const CAPTURE_DIR = process.env.MERCURY_STRIP_CAPTURE_DIR ?? null
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
  console.error(`prove-strip-bridge-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [CWD])

/** The face's canon ready line (the boot menu is on screen). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
/** The composer's placeholder (a chat is on screen). */
const COMPOSER = 'Type a prompt'
/** The board's header lockup (the concourse is on screen). */
const BOARD = 'SESSION CONCOURSE'
/** The focused chat's status row (a session holds the slot). */
const TAG = '⇧← back'
/** The face's key-map row: the strip's one present move from a fresh face. */
const FACE_TO_CONCOURSE = '⇧→ concourse'
/** The face's key-map row in the plain world with a chat open. */
const FACE_TO_CHAT = '⇧→ chat'
const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
/** Ticks the face waits before ↵ so the daemon pre-warm (fired from the
 *  REPL's mount hook beneath the face) and its warm runner are up. */
const WARM_TICKS = 25

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
      // The full house capture pins: the byte-still legs compare WHOLE
      // frames, and the coordinator pane's critter GAZE animated between
      // marks (S1 'differs at row 21') — every animation source stands
      // still under a byte-identical pin.
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
      MERCURY_HIP: '0',
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

/** The frame vshot snapshotted at `label` — the settled state BEFORE that
 *  send's bytes landed. */
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
const isFace = (frame: string): boolean => frame.includes(READY_LINE)
const isBoard = (frame: string): boolean => frame.includes(BOARD)
const isChat = (frame: string): boolean => frame.includes(COMPOSER) || frame.includes(TAG)
const firstRows = (frame: string): string => frame.split('\n').filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')

// ── S1: a bare boot has two stops; ⇧→ from the board is no movement ─────────
// Byte-still MODULO the composer caret's blink phase (▌ on / off) — the one
// cell a still frame legitimately toggles; everything else must match.
const still = (t: string): string => t.replace(/❯ ▌/g, '❯  ')

console.log('S1 — a bare boot: menu → concourse, and no further (byte-still)')
{
  const home = freshHome('bare')
  const c = await capture({
    id: 's1-bare-boot-two-stops',
    home,
    sends: [
      g(READY_LINE, SHIFT_RIGHT, { mark: 'face', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'board-before' },
      { afterPrevTicks: 5, data: '', mark: 'board-after' },
    ],
    stableTicks: 4,
    total: 120,
  })
  printFrame('s1 (after the second ⇧→)', c.lines)
  const face = markText(c, 'face')
  const before = markText(c, 'board-before')
  const after = markText(c, 'board-after')
  check('S1 the boot landed on the face', isFace(face), firstRows(face))
  check(`S1 the face's key-map row names the concourse alone ("${FACE_TO_CONCOURSE}") — no reserved chat advertised`, face.includes(FACE_TO_CONCOURSE) && !face.includes('move between screens') && !face.includes(FACE_TO_CHAT), face.split('\n').filter(l => l.includes('⇧')).join(' | '))
  check('S1 ⇧→ from the face landed the concourse', isBoard(before) && !isFace(before) && !isChat(before), firstRows(before))
  check('S1 ⇧→ from the concourse was NO MOVEMENT — the frame before and after are byte-identical (no bounce, no flash, no empty chat)', before !== '' && still(before) === still(after), still(before) === still(after) ? '' : `differs at row ${still(before).split('\n').findIndex((l, i) => l !== still(after).split('\n')[i])}`)
  check('S1 the settled frame is still the concourse: no boot menu (the retired rubber-band), no composer, no session tag bar', isBoard(c.text) && !isFace(c.text) && !isChat(c.text), firstRows(c.text))
  check('S1 walking the strip created no session (rule 1: a fresh boot has no chat)', Object.keys(liveRecords(home)).length === 0, JSON.stringify(Object.keys(liveRecords(home))))
  reapHome(home)
}

// ── S2: the chat stop appears at the birth and the strip walks all three ────
console.log('S2 — ↵ births the chat: the stop appears; the strip walks chat ⇄ board ⇄ menu')
{
  const home = freshHome('birth')
  const c = await capture({
    id: 's2-stop-appears',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { mark: 'chat', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'board' },
      { afterPrevTicks: 8, data: SHIFT_LEFT, mark: 'chat-again' },
      { afterPrevTicks: 8, data: SHIFT_LEFT, mark: 'board-again' },
      { afterPrevTicks: 8, data: '', mark: 'face-with-chat' },
    ],
    stableTicks: 4,
    total: 220,
  })
  printFrame('s2 (the face, a chat open behind the strip)', c.lines)
  check('S2 ↵ on New Session entered the born chat (composer + status row)', isChat(markText(c, 'chat')), firstRows(markText(c, 'chat')))
  check('S2 ⇧← from the chat is the board', isBoard(markText(c, 'board')) && !isChat(markText(c, 'board')), firstRows(markText(c, 'board')))
  check('S2 ⇧→ from the board re-enters the SAME chat (the stop appeared with the session)', isChat(markText(c, 'chat-again')), firstRows(markText(c, 'chat-again')))
  check('S2 ⇧← ⇧← from the chat reaches the board, then the face', isBoard(markText(c, 'board-again')) && isFace(markText(c, 'face-with-chat')), firstRows(markText(c, 'face-with-chat')))
  check(`S2 the face's row still names the concourse (the next stop right; the chat lies beyond it)`, markText(c, 'face-with-chat').includes(FACE_TO_CONCOURSE))
  check('S2 exactly ONE session exists — born by ↵, never by the strip', Object.keys(liveRecords(home)).length === 1, JSON.stringify(Object.keys(liveRecords(home))))
  reapHome(home)
}

// ── S3: the last chat closes; the stop vanishes ─────────────────────────────
// The operator's ruling on the ONLY
// session — "when you kill it, it should go back to the two
// screens": releasing the last row from the board ENDS the session and
// THE BOARD STAYS the frame with the strip at its two stops — never a
// bounce to the menu; ⇧← is the face, whose row names the concourse alone.
console.log('S3 — the last chat closed from the board: the board stays, and the chat stop is gone')
{
  const home = freshHome('close')
  const c = await capture({
    id: 's3-stop-vanishes',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      g('SESSIONS', '\t', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 3, data: 'x' },
      { afterPrevTicks: 2, data: 'x' },
      // 35 ticks: the release's "applied — removed from the board" note
      // expires (~4.5 s) BEFORE the byte-still pair is taken.
      { afterPrevTicks: 35, data: '', mark: 'board-stays' },
      // A mark snapshots BEFORE its own send's bytes (the vshot law) — each
      // chord's RESULT is read by the follow-up empty send. The first cut
      // marked the chord sends themselves and read pre-chord frames: the
      // byte-still leg compared two pre-⇧→ boards (vacuously green) and the
      // face leg read the pre-⇧← board (red on a healthy product) — the
      // "first chord after a release is swallowed" scare was this rig's own
      // wrong-frame read; the product walks the strip correctly.
      { afterPrevTicks: 3, data: SHIFT_RIGHT },
      { afterPrevTicks: 6, data: '', mark: 'board-after' },
      { afterPrevTicks: 3, data: SHIFT_LEFT },
      { afterPrevTicks: 8, data: '', mark: 'menu' },
    ],
    stableTicks: 4,
    total: 260,
  })
  printFrame('s3 (the face after ⇧← from the emptied board)', c.lines)
  const stays = markText(c, 'board-stays')
  const after = markText(c, 'board-after')
  const menu = markText(c, 'menu')
  check('S3 releasing the last row left THE BOARD on the frame (the two screens) — never the dead chat, never a bounce to the menu', isBoard(stays) && !isChat(stays) && !isFace(stays), firstRows(stays))
  check('S3 the release painted no refusal (poison: "✕ refused — stop refused" on the only session)', !/refused/.test(stays), stays.split('\n').filter(l => /refused/.test(l)).join(' | '))
  check('S3 ⇧→ from the board is NO MOVEMENT (byte-still): the closed chat is not a stop', stays !== '' && still(stays) === still(after))
  check('S3 ⇧← from the board is the face', isFace(menu) && !isChat(menu), firstRows(menu))
  check(`S3 the face's row names the concourse alone again (the chat stop vanished with the session)`, menu.includes(FACE_TO_CONCOURSE) && !menu.includes(FACE_TO_CHAT))
  check('S3 the roster is empty (the record ended — x-x is final)', Object.keys(liveRecords(home)).length === 0, JSON.stringify(Object.keys(liveRecords(home))))
  reapHome(home)
}

// ── S4: --chat is the plain world ───────────────────────────────────────────
console.log('S4 — --chat: the menu lands, ↵ births, then menu ⇄ chat with no concourse stop')
{
  const home = freshHome('chat')
  const c = await capture({
    id: 's4-chat-plain-world',
    home,
    argv: ['--chat'],
    sends: [
      g(READY_LINE, '', { mark: 'landing' }),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { mark: 'chat', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: SHIFT_LEFT, mark: 'menu' },
      { afterPrevTicks: 5, data: SHIFT_RIGHT, mark: 'menu-again' },
      { afterPrevTicks: 8, data: '', mark: 'chat-again' },
    ],
    stableTicks: 4,
    total: 240,
  })
  printFrame('s4 (--chat, back in the chat)', c.lines)
  const landing = markText(c, 'landing')
  const menu = markText(c, 'menu')
  check('S4 the landing is the boot menu (L15) — no chat born at boot', isFace(landing) && !isChat(landing), firstRows(landing))
  check('S4 the --chat face carries NO Session Concourse row and its row says "⇧→ no chat open"', !landing.includes('Session Concourse') && landing.includes('⇧→ no chat open'), landing.split('\n').filter(l => /Concourse|⇧/.test(l)).join(' | '))
  check('S4 ↵ births the chat', isChat(markText(c, 'chat')), firstRows(markText(c, 'chat')))
  check('S4 ⇧← from the chat is the BOOT MENU directly — no concourse between (the plain world)', isFace(menu) && !isBoard(menu), firstRows(menu))
  check(`S4 the menu's row names the chat ("${FACE_TO_CHAT}") — the one stop to its right`, menu.includes(FACE_TO_CHAT) && !menu.includes(FACE_TO_CONCOURSE), menu.split('\n').filter(l => l.includes('⇧')).join(' | '))
  check('S4 ⇧← from the menu is the strip\'s silent end (byte-still)', menu !== '' && markText(c, 'menu-again') === menu)
  check('S4 ⇧→ from the menu is the chat again', isChat(markText(c, 'chat-again')), firstRows(markText(c, 'chat-again')))
  check('S4 exactly ONE session exists — born at ↵, none at boot', Object.keys(liveRecords(home)).length === 1, JSON.stringify(Object.keys(liveRecords(home))))
  reapHome(home)
}

// ── S5: --concourse-off is the same world ───────────────────────────────────
console.log('S5 — --concourse-off: the face, then menu ⇄ chat with no live view on the strip')
{
  const home = freshHome('off')
  const c = await capture({
    id: 's5-concourse-off-plain-world',
    home,
    argv: ['--concourse-off'],
    sends: [
      g(READY_LINE, '', { mark: 'face' }),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { mark: 'chat', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'menu' },
      { afterPrevTicks: 8, data: '', mark: 'chat-again' },
    ],
    stableTicks: 4,
    total: 220,
  })
  printFrame('s5 (--concourse-off, back in the chat)', c.lines)
  const face = markText(c, 'face')
  const menu = markText(c, 'menu')
  check('S5 the switch boot landed the face, which reads the switch ("live view only")', isFace(face) && face.includes('live view only'), firstRows(face))
  check(`S5 with no chat the face's row says so ("⇧→ no chat open") — no concourse stop, no chat yet`, face.includes('⇧→ no chat open'), face.split('\n').filter(l => l.includes('⇧')).join(' | '))
  check('S5 ↵ births the chat', isChat(markText(c, 'chat')), firstRows(markText(c, 'chat')))
  check('S5 ⇧← from the chat is the face DIRECTLY — the live view is not a stop', isFace(menu) && !isBoard(menu), firstRows(menu))
  check(`S5 the face's row names the chat ("${FACE_TO_CHAT}")`, menu.includes(FACE_TO_CHAT))
  check('S5 ⇧→ from the face is the chat', isChat(markText(c, 'chat-again')), firstRows(markText(c, 'chat-again')))
  reapHome(home)
}

if (process.env.MERCURY_STRIP_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-strip-bridge-drive: ALL LAWS HOLD' : `\nprove-strip-bridge-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
