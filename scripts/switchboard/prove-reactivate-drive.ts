#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-reactivate-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'project')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
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

const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const BOARD = 'SESSION CONCOURSE'
const FACE_TO_CONCOURSE = keyHintLabel('⇧→ concourse')
const FACE_TO_CHAT = keyHintLabel('⇧→ chat')
const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const ARROW_DOWN = '\x1b[B'
const WARM_TICKS = 25
const WORDS = 'park me please'
const REPLY = 'Spare.'
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
      }
    }
  }
  const pid = daemonPidOf(home)
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
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
      { afterPrevTicks: 35, data: '', mark: 'board-stays' },
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
  const still = (t: string): string => t.replace(/❯ ▌/g, '❯  ')
  check('D1 ⇧→ from the board is byte-still (the chat stop is gone)', stays !== '' && still(stays) === still(after))
  check('D1 ⇧← is the face, whose row names the concourse alone', isFace(menu) && menu.includes(FACE_TO_CONCOURSE) && !menu.includes(FACE_TO_CHAT), firstRows(menu))
  reapHome(home)
}

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
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 3, data: '\r', mark: 'enter-parked' },
      { afterPrevTicks: REACTIVATE_BUDGET_TICKS, data: '', mark: 'reactivated' },
      g(COMPOSER, '/clear', { awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 25, data: SHIFT_LEFT },
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
  const down = await until(() => daemonPid === null || !isAlive(daemonPid), 30_000)
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
