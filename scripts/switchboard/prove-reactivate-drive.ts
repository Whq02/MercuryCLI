#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-reactivate-drive.ts — THE REACTIVATION LIFECYCLE
//  on the REAL built bundle through the PTY capture substrate (vshot.py) in
//  seeded scratch homes whose daemons live in those homes.
//  The operator's
//  strike captures land in MERCURY_REACTIVATE_CAPTURE_DIR.
//
//   D1  THE OPERATOR'S REPRO (ledger L15): ONE session born on ↵, its model
//       switched (the same set-model road the operator's GPT switch rode —
//       MERCURY_REACTIVATE_DRIVE_MODEL picks the id; the default is a
//       fixture-servable Anthropic id, so the GPT-specific leg is the pool's
//       to set), ⇧← to the board, x-x on the only row ⇒ the session ENDS,
//       the board STAYS with the strip at two stops (⇧→ byte-still, ⇧← the
//       face whose row names the concourse alone), and NO refusal is painted
//       (the poison: "✕ refused — stop refused");
//   D2  PARK → BOARD ROW → ↵ → LIVE → CLOSE → PARKED AGAIN → x-x → GONE: words
//       into the born chat (the fixture answers), /clear PARKS it and births
//       another; the board's PARKED group lists it by its first words with a
//       still cell; ↵ reactivates it IN PLACE — its words back on screen,
//       ONE un-ended record, live, not parked, within the felt budget;
//       /clear parks it again; x-x on the parked row ENDS the record and
//       clears the mark — gone;
//   D3  THE QUIT SURFACES: a messaged session and a newborn; the screen
//       dies (the rig ends it) ⇒ the owned daemon goes down with its owner,
//       every record STANDS (nothing silently vanishes or ends), and the
//       next boot's reconcile surfaces the death honestly ("crashed —
//       found dead", NEEDS YOU). The graceful owner-death drain (park the
//       messaged one, release the newborn, then exit) is UNBUILT — the
// the row; these pins flip to it when it lands.
// ============================================================================
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-reactivate-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'project')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
// The COEXISTENCE LAW (two sessions on one project need a git ground): D3
// births a second session beside the messaged one — on a bare folder the
// birth is HELD behind the git offer and the newborn never exists (the
// enter-class journeys stage the same ground for the same reason).
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: CWD })
execFileSync('git', ['-c', 'user.email=drive@fixture', '-c', 'user.name=drive', 'commit', '-q', '--allow-empty', '-m', 'ground'], { cwd: CWD })
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_REACTIVATE_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
/** The model the repro switches to (the operator switched to GPT; the
 *  fixture serves an Anthropic-shaped API, so the default is a servable id
 *  and the pool may point this at a GPT id where a fixture exists). */
const SWITCH_MODEL = process.env.MERCURY_REACTIVATE_DRIVE_MODEL ?? 'claude-opus-5'

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
  console.error(`prove-reactivate-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [CWD])

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const BOARD = 'SESSION CONCOURSE'
const FACE_TO_CONCOURSE = '⇧→ concourse'
const FACE_TO_CHAT = '⇧→ chat'
const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const ARROW_DOWN = '\x1b[B'
const WARM_TICKS = 25
const WORDS = 'park me please'
const REPLY = 'Spare.'
/** The reactivate's felt budget: the row flips live (a record with a live
 *  runner, not parked) within this many rig ticks of ↵ — the warm road's
 *  class; the cold road's number is merely recorded. */
const REACTIVATE_BUDGET_TICKS = 15

type Send = Record<string, unknown>
type Capture = { home: string; text: string; lines: string[]; status: number; tail: string; payload: Record<string, unknown> }

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; ready?: string; total?: number; stableTicks?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: REPLY }, { kind: 'text', text: REPLY }, { kind: 'text', text: REPLY }])
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
      // The full house capture pins: D1's byte-still leg compares WHOLE
      // frames, and the pane critter's idle sway animated between marks.
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

function markText(c: Capture, label: string): string {
  const marks = (c.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
  return (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(cell => cell.c).join('')).join('\n')
}
function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}
const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
const isFace = (frame: string): boolean => frame.includes(READY_LINE)
const isBoard = (frame: string): boolean => frame.includes(BOARD)
const isChat = (frame: string): boolean => frame.includes(COMPOSER)
const firstRows = (frame: string): string => frame.split('\n').filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
const standingOf = (home: string): ReturnType<typeof readSessionWorkers>[string][] => Object.values(recordsOf(home)).filter(r => r.endedAt === undefined)
const isAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function daemonPidOf(home: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, 'daemon', 'daemon.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
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
  const pid = daemonPidOf(home)
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
}
async function until(cond: () => boolean, ms: number, step = 500): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, step))
  }
  return cond()
}
function parkedClearedOf(home: string): string[] {
  try {
    const draft = JSON.parse(readFileSync(join(home, 'concourse-draft.json'), 'utf8')) as { parkedCleared?: Record<string, unknown> }
    return Object.keys(draft.parkedCleared ?? {})
  } catch {
    return []
  }
}

// ── D1: the operator's repro — x-x on the only session ──────────────────────
console.log('D1 — the only session: x-x ends it, the board stays with two stops, no refusal')
{
  const home = freshHome('only')
  const c = await capture({
    id: 'd1-only-session',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, `/model ${SWITCH_MODEL}`, { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 12, data: '', mark: 'switched' },
      { afterPrevTicks: 2, data: SHIFT_LEFT },
      g(BOARD, '\t', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 3, data: 'x' },
      { afterPrevTicks: 2, data: 'x' },
      // 35 ticks: the release note expires before the byte-still pair.
      { afterPrevTicks: 35, data: '', mark: 'board-stays' },
      // Each chord's result is read by a follow-up empty send — a mark
      // snapshots BEFORE its own send's bytes (the vshot law; the first cut
      // read pre-chord frames and called the healthy strip a swallow).
      { afterPrevTicks: 3, data: SHIFT_RIGHT },
      { afterPrevTicks: 6, data: '', mark: 'board-after' },
      { afterPrevTicks: 3, data: SHIFT_LEFT },
      { afterPrevTicks: 8, data: '', mark: 'menu' },
    ],
    stableTicks: 4,
    total: 320,
  })
  printFrame('d1 (the board after x-x on the only session)', markText(c, 'board-stays').split('\n'))
  const stays = markText(c, 'board-stays')
  const after = markText(c, 'board-after')
  const menu = markText(c, 'menu')
  check('D1 the model switch landed on the chat (the set-model road the repro rode)', markText(c, 'switched').includes(COMPOSER), firstRows(markText(c, 'switched')))
  check('D1 x-x on the only session ENDED it (no standing record)', standingOf(home).length === 0, JSON.stringify(standingOf(home).map(r => [r.runnerId, r.parkedAt !== undefined, r.crash?.reason])))
  check('D1 the board STAYS the frame — the two screens — never the dead chat, never a bounce to the menu', isBoard(stays) && !isChat(stays) && !isFace(stays), firstRows(stays))
  check('D1 NO refusal painted (poison: "✕ refused — stop refused")', !/refused/.test(stays), stays.split('\n').filter(l => /refused/.test(l)).join(' | '))
  // Byte-still MODULO the composer caret's blink phase (▌ on / off).
  const still = (t: string): string => t.replace(/❯ ▌/g, '❯  ')
  check('D1 ⇧→ from the board is byte-still (the chat stop is gone)', stays !== '' && still(stays) === still(after))
  check('D1 ⇧← is the face, whose row names the concourse alone', isFace(menu) && menu.includes(FACE_TO_CONCOURSE) && !menu.includes(FACE_TO_CHAT), firstRows(menu))
  reapHome(home)
}

// ── D2: park → board row → ↵ → live → close → parked again → x-x → gone ──────
console.log('D2 — park, reactivate in place, park again, x-x: gone')
{
  const home = freshHome('cycle')
  const c = await capture({
    id: 'd2-park-reactivate',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, WORDS, { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      g(REPLY, '/clear', { awaitSettleTicks: 4, mark: 'answered' }),
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 25, data: SHIFT_LEFT },
      g(BOARD, '', { awaitSettleTicks: 4, mark: 'board-parked' }),
      { afterPrevTicks: 2, data: '\t' },
      { afterPrevTicks: 2, data: ARROW_DOWN },
      // ARM-THEN-ENTER (the ruled L17 grammar): ↵ arms the parked row, the
      // second ↵ enters it.
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 3, data: '\r', mark: 'enter-parked' },
      { afterPrevTicks: REACTIVATE_BUDGET_TICKS, data: '', mark: 'reactivated' },
      g(COMPOSER, '/clear', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 25, data: SHIFT_LEFT },
      // NO tab and NO ↓ at the second walk: the board KEEPS both the region
      // (list — walk 1's tab) and the selection (the parked row, by the
      // kept session identity) across the enter/exit round trip. Tab here
      // CYCLES the ring onward (list → live) and the live composer's
      // type-to-message arm then swallows x into the parked target's gate
      // refusal ('a sleeping chat takes no queue') — the first cut's red;
      // the instrumented walk showed ▸ already on the parked row pre-tab.
      g(BOARD, '', { awaitSettleTicks: 4, mark: 'board-parked-again' }),
      { afterPrevTicks: 2, data: 'x' },
      { afterPrevTicks: 2, data: 'x' },
      { afterPrevTicks: 20, data: '', mark: 'gone' },
    ],
    stableTicks: 4,
    total: 600,
  })
  printFrame('d2 (the board after x-x on the parked row)', markText(c, 'gone').split('\n'))
  const boardParked = markText(c, 'board-parked')
  const reactivated = markText(c, 'reactivated')
  const again = markText(c, 'board-parked-again')
  const gone = markText(c, 'gone')
  const all = Object.values(recordsOf(home))
  const oldRec = all.find(r => r.lastDeliveryAt !== undefined)
  check('D2 the words were answered before /clear', markText(c, 'answered').includes(REPLY), firstRows(markText(c, 'answered')))
  check('D2 /clear PARKED the chat: the board lists it by its first words with a still "parked ·" cell', isBoard(boardParked) && boardParked.includes(WORDS) && /parked · \d\dm/.test(boardParked), boardParked.split('\n').filter(l => l.includes(WORDS) || l.includes('parked')).join(' | '))
  check('D2 ↵ on the parked row brought the SAME chat back: its words on screen within the felt budget', isChat(reactivated) && reactivated.includes(WORDS), firstRows(reactivated))
  const marks = (c.payload.marks as Array<{ label: string; atTick: number }> | undefined) ?? []
  const enterTick = marks.find(m => m.label === 'enter-parked')?.atTick
  const paintedTick = marks.find(m => m.label === 'reactivated')?.atTick
  console.log(`  [FELT] ↵ on the parked row at tick ${enterTick ?? '∅'}; the chat with its words was on screen at tick ${paintedTick ?? '∅'} (${enterTick !== undefined && paintedTick !== undefined ? `${(paintedTick - enterTick) * 200} ms` : '∅'}, budget ${REACTIVATE_BUDGET_TICKS * 200} ms — the warm road's class; the daemon log's "warm claim acked in Nms … takes back session" line carries the ack number for the receipt)`)
  check('D2 the parked row was reactivated IN PLACE: exactly ONE un-ended record ever owned the session', all.filter(r => r.sessionId === oldRec?.sessionId).length === 1, JSON.stringify(all.map(r => [r.runnerId, r.sessionId.slice(-4), r.endedAt !== undefined, r.parkedAt !== undefined])))
  check('D2 /clear parked it AGAIN: the board lists it parked once more', isBoard(again) && again.includes(WORDS) && /parked · \d\dm/.test(again), again.split('\n').filter(l => l.includes(WORDS)).join(' | '))
  check('D2 x-x on the parked row: the record ENDED and the board\'s mark cleared it — gone', oldRec !== undefined && oldRec.endedAt !== undefined && parkedClearedOf(home).includes(oldRec.sessionId) && !gone.includes(WORDS), JSON.stringify({ ended: oldRec?.endedAt !== undefined, cleared: parkedClearedOf(home).length, onFrame: gone.includes(WORDS) }))
  check('D2 the board stays the frame after the release (the newest chat is the survivor; nothing bounces)', isBoard(gone) && !isFace(gone), firstRows(gone))
  reapHome(home)
}

// ── D3: the quit surfaces (the graceful drain is the row) ───
console.log('D3 — the screen dies: records stand, the daemon goes down, the next boot surfaces the death')
{
  const home = freshHome('quit')
  const c = await capture({
    id: 'd3-quit-parks-all',
    home,
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, WORDS, { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      g(REPLY, SHIFT_LEFT, { awaitSettleTicks: 4 }),
      g(BOARD, '\t', { awaitSettleTicks: 3 }),
      // 'n' opens the CONTRACT OFFER first (L25) — esc births plain (the No
      // leg); without the answer the card stands and no newborn ever exists.
      { afterPrevTicks: 2, data: 'n' },
      g('contract', '\x1b', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 15, data: '', mark: 'two-sessions' },
    ],
    stableTicks: 4,
    total: 260,
  })
  const before = standingOf(home)
  check('D3 two sessions stood when the screen died — one messaged, one newborn', before.length === 2 && before.some(r => r.lastDeliveryAt !== undefined) && before.some(r => r.bornBlankAt !== undefined && r.lastDeliveryAt === undefined), JSON.stringify(before.map(r => [r.runnerId, r.lastDeliveryAt !== undefined])))
  const daemonPid = daemonPidOf(home)
  // THE PRESENT LAW (rooted at the gate loop): the owned daemon
  // has NO owner-death drain — ownerWatch carries no park path, so a hard
  // screen kill takes the daemon and its runners down UNGRACEFULLY and the
  // NEXT BOOT's reconcile surfaces the death honestly ('crashed — found
  // dead', NEEDS YOU — the operator sees what died; ↵↵ brings the chat
  // back). The WANTED shape (park the messaged chat · release the newborn ·
  // then exit — a graceful owner-death drain) is a DAEMON feature, rowed
  // for the sweep; when it lands, these checks flip to the drain's
  // truth (parked, never crashed). Until then the pins hold what is:
  // records STAND (nothing silently vanishes) and the death is SURFACED.
  const down = await until(() => daemonPid === null || !isAlive(daemonPid), 30_000)
  // The runners die when the daemon's death propagates to them — an owner
  // chain, not an instant; the read waits for the chain, bounded.
  await until(() => Object.values(recordsOf(home)).every(r => !isAlive(r.pid)), 45_000)
  const settled = Object.values(recordsOf(home))
  const messaged = settled.find(r => r.lastDeliveryAt !== undefined)
  check('D3 no record silently vanished or ended with the screen (both stand for the next boot)', settled.length === 2 && settled.every(r => r.endedAt === undefined), JSON.stringify(settled.map(r => [r.runnerId, r.parkedAt !== undefined, r.endedAt !== undefined, r.crash?.reason])))
  check('D3 the messaged chat is the standing record the next boot will surface', messaged !== undefined, JSON.stringify(settled.map(r => r.runnerId)))
  check('D3 the owned daemon went down with its owner (no runner survives it)', down && settled.every(r => !isAlive(r.pid)), JSON.stringify({ daemonPid, alive: settled.map(r => isAlive(r.pid)) }))
  const boot = await capture({
    id: 'd3-boot-after-quit',
    home,
    sends: [g(READY_LINE, SHIFT_RIGHT, { awaitSettleTicks: 4 }), g(BOARD, '', { awaitSettleTicks: 4, mark: 'board' })],
    stableTicks: 4,
    total: 160,
  })
  printFrame('d3 (the board on the next boot)', markText(boot, 'board').split('\n'))
  const board = markText(boot, 'board')
  check('D3 the next boot SURFACES the death honestly — the messaged chat on the board as NEEDS YOU "crashed — found dead", never silently gone (the graceful park is the daemons row)', isBoard(board) && board.includes(WORDS) && /crashed/.test(board), board.split('\n').filter(l => l.includes(WORDS) || /NEEDS|crash/.test(l)).join(' | '))
  reapHome(home)
  void c
}

if (process.env.MERCURY_REACTIVATE_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-reactivate-drive: ALL LAWS HOLD' : `\nprove-reactivate-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
