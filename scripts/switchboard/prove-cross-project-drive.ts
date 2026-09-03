#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-cross-project-drive.ts — CROSS-PROJECT AWARENESS
//  on the REAL built bundle through the PTY capture substrate (vshot.py) in
//  seeded scratch homes whose daemons live in those homes.
//  The operator's strike captures land
//  in MERCURY_CROSSPROJ_CAPTURE_DIR.
//
//  THE INVARIANT (the operator): the board = the current project's sessions
//  + the one focused session (★ if foreign) + a running-count line per other
//  project with activity; switching projects moves your eyes, never your
//  sessions.
//
//  THE COMBINATION TABLE (every cell pinned — here on the bundle where the
//  cell needs a boot, in prove-cross-project.ts §1–§7 where it needs none):
//
//   focused    | switch  | focus-local | finish-elsewhere | the board shows
//   -----------+---------+-------------+------------------+------------------------------------------
//   none       | A→B     | –           | –                | B's rows; A's line "N running in A"      (§1, §4, D1)
//   X of A     | stay A  | –           | –                | X a plain row, no ★                      (§2)
//   X of A     | A→B     | –           | –                | X ★ from A; A's line counts the rest     (§2, §4, D1)
//   X of A     | A→B     | Y of B      | –                | Y plain, X gone, A's line counts X too   (§3, §4, D1)
//   X of A     | A→B→A   | –           | –                | X plain again; B's line if B is active   (§3)
//   X (no rec) | A→B     | –           | –                | X ★ parked, first in PARKED              (§2)
//   any        | any     | any         | in B, view A     | rail: "switch to B · finished" (door)    (§5, D3)
//   any        | any     | any         | in A, view A     | no ping (a row in front of you)          (§5)
//   any        | any     | any         | old news at boot | no ping (seed-silent); line says finished (§5)
//   any        | any     | any         | ask in B, view A | rail: "switch to B · needs you" (door)   (§5)
//   counts     | –       | –           | –                | seats global; lines name-ordered, top 3, +N more (§2, §4)
//   plain world| –       | –           | –                | no lines, no doors, no mint, face silent (§5, §6, D4)
//   boot face  | –       | –           | –                | "foo (N running)" from the same owner    (§6, D2)
//
//   D1  TWO PROJECTS, THE ★ CARRY-OVER, THE SILENT HAND-BACK, THE LINE: boot
//       in P; ↵ births X; from the board n births Y (focused); ⌃g picks Q →
//       Q's board carries Y with "✦ from P" and paints "1 running in P ·
//       switch to see them" (X); n births Z in Q → Y is gone from Q's board
//       (no notice) and the line reads "2 running in P". Every record of X,
//       Y, Z is live at the end — nothing paused, parked, retired, released.
//   D2  THE LINE IS A DOOR + THE FACE: ↓ ↵ on P's line switches the view to
//       P — X and Y as plain live rows, Z with "✦ from Q"; ⇧← the face's
//       Sessions · Projects row counts the repos it knows ("N repos · pick a
//       session"); the running count is the board's line.
//   D3  THE PING IS A DOOR: words sent into Z (Q), the view switched to P
//       before its turn settles → the rail rows "switch to Q · finished";
//       ↵ on it switches the view to Q and opens Z's chat. TIMING: the
//       switch must land before the fixture's reply settles the turn —
//       sized generously; the pool may tune a tick (a settle that lands
//       first is watched in its own project and never pings — the law).
//   D4  THE PLAIN WORLD: `--chat` never paints an OTHER PROJECTS group, a
//       door, or a "(N running)" suffix anywhere in its run.
// ============================================================================
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-crossproj-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'proj-p')
const OTHER = join(SCRATCH, 'proj-q')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(OTHER, { recursive: true })
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_CROSSPROJ_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-cross-project-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

// Both folders trusted at first run (the trust gate has its own pins in
// prove-concourse-flow-laws; this drive is about the cross-project laws).
seedFirstRun(TEMPLATE, [CWD, OTHER])

// Q is a WORKED-IN project (the picker lists it): one durable chat with
// words in Q's session home under the template — every fresh home inherits
// it (and Q's board shows it as a parked row).
{
  const sessionId = '00000000-dddd-4000-8000-000000000001'
  const file = workerTranscriptPath({ sessionId, workspaceId: OTHER })
  mkdirSync(dirname(file), { recursive: true })
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: OTHER,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date().toISOString(),
    ...extra,
  })
  writeFileSync(
    file,
    encodeSeedTranscript(
      [
        row({ type: 'user', message: { role: 'user', content: 'an old chat in q' } }),
        row({ type: 'assistant', message: { id: 'msg_q', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      ] as never,
      sessionId,
    ),
  )
  const at = new Date(Date.now() - 60 * 60_000)
  utimesSync(file, at, at)
}

const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
/** The face's canon ready line (the boot menu is on screen). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
/** The composer's placeholder (a chat is on screen). */
const COMPOSER = 'Type a prompt'
/** The board's header lockup (the concourse is on screen). */
const BOARD = 'SESSION CONCOURSE'
/** The focused chat's status row (a session holds the slot) — spelled by
 *  the ONE platform-aware owner (off macOS the product paints "shift+←"). */
const TAG = keyHintLabel('⇧← back')
/** The ★ mark's words on a carried-over row. */
const FROM_P = `✦ from ${basename(CWD)}`
const FROM_Q = `✦ from ${basename(OTHER)}`
/** The count line's words. */
const LINE_P = `running in ${basename(CWD)}`
const LINE_Q = `running in ${basename(OTHER)}`
// The line's project label is the path's tail behind a leading ellipsis when
// the row is narrower than the path ("2 running in …proj-p"): the needles
// read the count, the verb and the basename, and let the ellipsis stand.
const lineRe = (count: number | null, project: string): RegExp => new RegExp(`${count === null ? '\\d+' : String(count)} running in …?${basename(project)}\\b`)
const DOOR = 'switch to see them'
const GROUP = 'OTHER PROJECTS'
/** The rail row of a finish elsewhere. */
const PING_Q = `switch to ${basename(OTHER)} · finished`
const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const CTRL_G = '\x07'
const ESC = String.fromCharCode(27)
/** Ticks the face waits before ↵ so the daemon pre-warm and its warm runner
 *  are up. */
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

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; ready?: string; total?: number; stableTicks?: number; replies?: number; slowFirstReply?: boolean }): Promise<Capture> {
  // slowFirstReply: the FIRST turn holds ~6s before its deltas land — the
  // cross-project finish law needs the reply to settle AFTER the operator
  // detached and switched projects (an attached or delivered-while-viewed
  // settle is never a finish; a current-project settle never mints).
  const api = await startFixtureApi([
    ...(opts.slowFirstReply === true ? [{ kind: 'paced' as const, deltas: ['Spare', '.'], gapMs: 300, startDelayMs: 6000 }] : []),
    ...Array.from({ length: opts.replies ?? 4 }, () => ({ kind: 'text' as const, text: 'Spare.' })),
  ])
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
const rowsWith = (frame: string, needle: string): string => frame.split('\n').filter(l => l.includes(needle)).map(l => l.trim().slice(0, 100)).join(' | ')
/** The sequence from the board (list region) that picks Q in the REPO
 *  picker: ⌃g opens it on the current ground's row; ↓ is Q (the one
 *  worked-in project besides the boot folder); ↵ launches there. */
const PICK_Q: Send[] = [
  { afterPrevTicks: 6, data: CTRL_G },
  { afterPrevTicks: 6, data: DOWN },
  { afterPrevTicks: 4, data: '\r' },
]
const PICK_P: Send[] = [
  { afterPrevTicks: 6, data: CTRL_G },
  { afterPrevTicks: 6, data: UP },
  { afterPrevTicks: 4, data: '\r' },
]

// ── D1: two projects, the ★ carry-over, the silent hand-back, the line ──────
console.log('D1 — X and Y born in P (Y focused); pick Q: Y ★ from P, "1 running in P"; n births Z in Q: Y handed back silently, "2 running in P"')
{
  const home = freshHome('carry')
  const c = await capture({
    id: 'd1-carry-over-and-hand-back',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      g('SESSIONS', '\t', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 4, data: 'n' },
      { afterPrevTicks: 6, data: ESC }, // the folded n ARMS the contract offer - esc is the No leg and births plain
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4, mark: 'p-board-before-pick' }),
      ...PICK_Q,
      { afterPrevTicks: 20, data: '', mark: 'q-board-carried' },
      // the picker opened FROM the list and closes back to it - a tab here
      // would move focus to the mirror where n is dead
      { afterPrevTicks: 4, data: 'n' },
      { afterPrevTicks: 4, data: ESC }, // the folded n ARMS the contract offer - esc is the No leg and births plain
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      { afterPrevTicks: 20, data: '', mark: 'q-board-handed-back' },
    ],
    stableTicks: 4,
    total: 420,
    replies: 6,
  })
  printFrame('d1 (Q\'s board after Z was born there)', c.lines)
  const carried = markText(c, 'q-board-carried')
  const handedBack = markText(c, 'q-board-handed-back')
  check('D1 the pick landed Q\'s board', isBoard(carried), firstRows(carried))
  check(`D1 the focused chat (Y, of P) rides Q's board with the star (the glyph leads; the row names its home)`, carried.split('\n').some(l => l.includes('✦') && l.includes('proj-p')), rowsWith(carried, '✦'))
  check(`D1 P's other session is a LINE, not a row: "1 ${LINE_P} · ${DOOR}" under ${GROUP}`, carried.includes(GROUP) && lineRe(1, CWD).test(carried) && carried.includes(DOOR), rowsWith(carried, 'running in'))
  check('D1 Q\'s old chat is a parked row of Q (the current project\'s chats)', carried.includes('PARKED') && carried.split('\n').some(l => l.includes('an old chat i') && l.includes(basename(OTHER))), rowsWith(carried, 'an old chat'))
  check('D1 after n births Z in Q, Y is HANDED BACK — no star on Q\'s board, no notice', isBoard(handedBack) && !handedBack.includes('✦') && !handedBack.includes('NEEDS YOU'), rowsWith(handedBack, '✦'))
  check(`D1 P's line now counts both: "2 ${LINE_P}"`, lineRe(2, CWD).test(handedBack), rowsWith(handedBack, 'running in'))
  const live = liveRecords(home)
  const homes = Object.values(live).map(r => r.workspaceId)
  check('D1 three sessions live — two in P, one in Q — and none paused, parked, stopped, retired or released by any switch', Object.keys(live).length === 3 && homes.filter(w => w === CWD).length === 2 && homes.filter(w => w === OTHER).length === 1 && Object.values(live).every(r => r.pausedAt === undefined && r.stoppedAt === undefined && r.retired === undefined), JSON.stringify(homes.map(w => basename(w))))
  reapHome(home)
}

// ── D2: the line is a door; the face reads the same count ───────────────────
console.log('D2 — ↵ on P\'s line switches the view to P (X, Y plain; Z ★ from Q); the face\'s Projects row reads the running count')
{
  const home = freshHome('door')
  const c = await capture({
    id: 'd2-line-is-a-door-and-face',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      g('SESSIONS', '\t', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 4, data: 'n' },
      { afterPrevTicks: 6, data: ESC }, // the folded n ARMS the contract offer - esc is the No leg and births plain
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      ...PICK_Q,
      // the picker closes back to the LIST - no tab, or n lands in the mirror
      { afterPrevTicks: 20, data: 'n' },
      { afterPrevTicks: 6, data: ESC }, // the folded n ARMS the contract offer - esc is the No leg and births plain
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      // The list region: the board re-entry focuses the COORDINATOR (A1) -
      // one tab reaches the list, then Z (selected), then P's line: ↓ ↵ door.
      { afterPrevTicks: 6, data: '\t' },
      { afterPrevTicks: 6, data: DOWN, mark: 'q-board' },
      { afterPrevTicks: 4, data: '\r' },
      { afterPrevTicks: 20, data: SHIFT_LEFT, mark: 'p-board-via-door' },
      { afterPrevTicks: 10, data: '', mark: 'face' },
    ],
    stableTicks: 4,
    total: 460,
    replies: 6,
  })
  printFrame('d2 (the face after the door)', c.lines)
  const qBoard = markText(c, 'q-board')
  const pBoard = markText(c, 'p-board-via-door')
  const face = markText(c, 'face')
  check(`D2 Q's board carried P's line ("2 ${LINE_P}") for the door`, isBoard(qBoard) && lineRe(2, CWD).test(qBoard), rowsWith(qBoard, 'running in'))
  check('D2 ↵ on the line switched the VIEW to P: the board (no chat opened by the door)', isBoard(pBoard) && !isChat(pBoard), firstRows(pBoard))
  check(`D2 P's sessions are plain live rows now (no line for P, no star on them); Z (focused, of Q) is the star (glyph + home)`, !lineRe(null, CWD).test(pBoard) && pBoard.split('\n').some(l => l.includes('✦') && l.includes('proj-q')), rowsWith(pBoard, '✦'))
  check('D2 Q has no line (its one session is on this board as the star — the line counts what you do not see)', !lineRe(null, OTHER).test(pBoard))
  check('D2 ⇧← is the face; its Sessions · Projects row counts the repos it knows ("1 repo · pick a session" — the running count is the board\'s line, never the face\'s)', isFace(face) && /\b[1-9]\d* repos? · pick a session/.test(face), rowsWith(face, 'pick a session'))
  reapHome(home)
}

// ── D3: the ping is a door ──────────────────────────────────────────────────
console.log('D3 — a turn settles in Q while the view is P: the rail rows "switch to Q · finished"; ↵ switches the view to Q and opens the chat')
{
  const home = freshHome('ping')
  const c = await capture({
    id: 'd3-ping-is-a-door',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      ...PICK_Q,
      // A1 composer-first: the pick closes back onto the COORDINATOR
      // composer - one tab reaches the list, or the n is a typed letter
      // (letterVerbsYield), not the birth verb.
      { afterPrevTicks: 12, data: '\t' },
      { afterPrevTicks: 2, data: 'n' },
      { afterPrevTicks: 6, data: ESC }, // the folded n ARMS the contract offer - esc is the No leg and births plain
      // Words into Z (Q) — its turn runs against the fixture; the switch
      // to P must land BEFORE the reply settles the turn (the timing
      // caveat in the header).
      g(COMPOSER, 'hello there\r', { awaitSettleTicks: 2 }),
      { afterPrevTicks: 2, data: SHIFT_LEFT },
      ...PICK_P,
      { afterPrevTicks: 60, data: '', mark: 'p-board-pinged' },
      // The rail: tab reaches it (the region ring ends on the rail while a
      // need stands); ↵ takes the door.
      // The picker closed back to the LIST; the ring while a need stands
      // is coordinator > list > live > rail (the mirror and its composer
      // are ONE stop) - two tabs reach the rail, and ↵ takes the door.
      { afterPrevTicks: 4, data: '\t' },
      { afterPrevTicks: 3, data: '\t' },
      { afterPrevTicks: 4, data: '\r', mark: 'rail-focused' },
      { afterPrevTicks: 25, data: SHIFT_LEFT, mark: 'chat-via-door' },
      { afterPrevTicks: 12, data: '', mark: 'q-board-after-door' },
    ],
    stableTicks: 4,
    total: 520,
    replies: 6,
    slowFirstReply: true,
  })
  printFrame('d3 (Q\'s board after the door)', c.lines)
  const pinged = markText(c, 'p-board-pinged')
  const chat = markText(c, 'chat-via-door')
  const qAfter = markText(c, 'q-board-after-door')
  check(`D3 the finish elsewhere rows on P's rail as "${PING_Q}" (NEEDS YOU · the ⚑ counts it)`, isBoard(pinged) && pinged.includes('NEEDS YOU') && pinged.includes(PING_Q), rowsWith(pinged, 'switch to'))
  check('D3 the rail row\'s one affordance is "switch & open"', pinged.includes('switch & open'), rowsWith(pinged, 'switch &'))
  check('D3 ↵ on the ping opened Z\'s chat (the door: switch + focus)', isChat(chat) && chat.includes('hello there'), firstRows(chat))
  check('D3 ⇧← from that chat is Q\'s board — the view switched with the door; Z a plain row; the need settled (no rail)', isBoard(qAfter) && !qAfter.includes(FROM_Q) && !qAfter.includes(PING_Q), rowsWith(qAfter, 'switch to'))
  reapHome(home)
}

// ── D4: the plain world ─────────────────────────────────────────────────────
console.log('D4 — --chat: no OTHER PROJECTS group, no door, no running suffix anywhere in the run')
{
  const home = freshHome('plain')
  const c = await capture({
    id: 'd4-plain-world',
    home,
    argv: ['--chat'],
    sends: [
      // L15 (landed on main): a --chat boot lands on the BOOT
      // MENU — no session is born at boot; ↵ New Session is the door (the
      // same face-↵ prelude D1 boots with; the menu's mount warms the
      // daemon and its runner beneath the face).
      g(READY_LINE, '', { mark: 'landing' }),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { mark: 'chat', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: '', mark: 'face' },
    ],
    stableTicks: 4,
    total: 260,
  })
  printFrame('d4 (--chat, the face)', c.lines)
  const landing = markText(c, 'landing')
  const face = markText(c, 'face')
  check('D4 the landing is the boot menu (L15: no session born at boot); ↵ New Session births the chat; ⇧← is the face directly', isFace(landing) && !landing.includes(COMPOSER) && isChat(markText(c, 'chat')) && isFace(face), firstRows(landing))
  check('D4 nothing of this lane paints in the plain world: no group, no door, no running suffix', !c.text.includes(GROUP) && !c.text.includes(DOOR) && !face.includes(' running') && !landing.includes(' running') && !markText(c, 'chat').includes(GROUP))
  reapHome(home)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-cross-project-drive: ALL LAWS HOLD' : `\nprove-cross-project-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
