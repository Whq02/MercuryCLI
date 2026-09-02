#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-reap-focus-drive.ts — operator item 4, the
//  reaped-session ghost, DRIVEN on the built bundle: a real scratch daemon
//  hosting two fixture-served sessions, the real concourse, real keys.
//
//   R1  enter session A from the board (the slot points at A), ⇧← back,
//       reap A with the double-x, then step to the focused chat (⇧→): the
//       chat that opens is the SURVIVOR — never the reaped session.
//   R2  reap the LAST session the same way: closing the last chat lands the
//       BOOT MENU (Law 9, rule 5: the retired
//       "fresh blank chat at the screen's cwd" landing), never a dead
//       session and never a ghost. THE STRIP COUNTS ITS STOPS FROM WHAT
//       EXISTS (the reserved chat
//       stop retires): ⇧→ from the menu is the board, and ⇧→ from the
//       board is NO MOVEMENT (no chat stop exists after the last reap) —
//       never the dead chat, never a bounce back to the menu.
//   R3  the honesty leg: ⇧← from the board after a reap lands the Boot face
//       (the strip's left stop) — recorded, not assumed.
//  Hermetic: scratch home + daemon dir + ONE scratch git ground — the
//  board is project-scoped (its rows are the ground's own sessions), so
//  both probes are born in the ground itself: the second birth collides on
//  the main checkout and the admission carves it a worktree, its record
//  keeping the origin workspace (a sibling repo with chats of its own would
//  be its own project and never a row here). The fixture API serves every
//  model call; children are released, then the daemon is terminated, then
//  the fixture closes.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'reap-drive-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const ground = join(SCRATCH, 'ground')
for (const d of [home, daemonDir, ground]) mkdirSync(d, { recursive: true })
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: ground })
spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@x', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: ground })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
const OUT_DIR = process.env.CONCFLOW_CAPTURE_DIR ?? join(tmpdir(), `reap-drive-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [ground])
{
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  // The fixture key is pre-approved (the last-20-chars normal form) so the
  // TUI boot never parks on the custom-API-key consent.
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

// R4 (the lead's leak-regression condition on the scope-aware keybinding
// gate): alpha's first turn PARKS a real Bash ask (the ask rule below), so
// alpha's consent card lives in the parked REPL; beta answers plainly.
writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }))
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'tool_use', whenModel: 'opus', name: 'Bash', input: { command: `rm -f ${join(SCRATCH, 'nothing-here')}`, description: 'tidy' }, preText: 'about to tidy up. ' },
  { kind: 'text', whenModel: 'sonnet', text: 'beta ready.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const childEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_AWAY_SUMMARY: '0',
}
const daemon = spawn('node', [BIN, 'daemon', 'run', ground], { cwd: ground, env: childEnv, stdio: ['ignore', logFd, logFd] })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  /** vshot snapshots the grid the moment this send becomes due — the frame
   *  BEFORE its bytes land, i.e. the settled state of the previous send. */
  mark?: string
}
/** The frames vshot snapshotted at each `mark` send, keyed `${tag}:${label}`. */
const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function drive(tag: string, sends: Send[], total: number, cols = 120, rows = 40): string[] {
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  // The TUI boots in the ground: the board it lands on is the ground's
  // project, whose rows are exactly the two probes born there.
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: ground, sends, total, cols, rows, out }))
  const env: Record<string, string> = { ...(childEnv as Record<string, string>), MERCURY_CONCOURSE: 'always' }
  delete env.MERCURY_CONCOURSE_FIXTURE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
const tagLine = (lines: string[]): string | undefined => lines.find(l => l.includes('⇧← back'))
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))

const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'

try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  check('the scratch daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const admit = async (title: string, work: string, cmid: string, modelKey: string): Promise<string> => {
    const d = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: cmid,
      prompt: `say ${title} is ready`,
      workspaceDir: work,
      title,
      modelKey,
      effort: 'high',
    } as never)) as { ok?: boolean; sessionId?: string; error?: string; detail?: string }
    check(`${title} dispatched`, d.ok === true && d.sessionId !== undefined, JSON.stringify(d))
    return d.sessionId ?? ''
  }
  // Both born in the ground: the second collides on the main checkout and
  // the admission carves it a worktree (its record keeps the origin
  // workspace), so both rows are the board's own.
  const sidA = await admit('alpha probe', ground, 'reap-drive-alpha', 'claude-opus-5')
  const sidB = await admit('beta probe', ground, 'reap-drive-beta', 'claude-sonnet-5')
  const liveIds = (): string[] =>
    Object.values(sup.readSessionWorkers(daemonDir))
      .filter(r => r.endedAt === undefined)
      .map(r => r.sessionId)
  check('both sessions live on the roster', await untilAsync(() => liveIds().includes(sidA) && liveIds().includes(sidB), 30_000), liveIds().join(','))
  // Let the first turns land: alpha parks its Bash ask (a real obligation),
  // beta answers its text turn.
  const obligations = await import('../../src/services/crew/obligations.ts')
  const alphaAskOpen = async (): Promise<boolean> =>
    (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sidA && (o.ref ?? '').startsWith('permission:'))
  check('alpha parked a REAL permission ask (its card lives in the parked REPL)', await untilAsync(alphaAskOpen, 40_000))
  await untilAsync(() => api.requests.length >= 2, 40_000)
  await new Promise(r => setTimeout(r, 2500))

  // ── R4: the leak-regression leg — one keypress, two mounted cards ──
  // A git-init obligation arms the pane's standard card on the board (the
  // daemon never minted it, so answering it comes back 'unknown' — the
  // refusal note IS the proof the key reached the pane's card); alpha's
  // parked ask (its card in the covered REPL beneath) must stay parked.
  console.log('R4 the parked REPL card stays dead under the Concourse while the in-pane card answers')
  const plainFolder = join(SCRATCH, 'plain-folder')
  mkdirSync(plainFolder, { recursive: true })
  await obligations.upsertObligation({
    ref: 'permission:git-init:deadbeef0001',
    sessionId: `folder:${plainFolder}`,
    question: `this folder has no git — start one in ${plainFolder} so sessions can fork it?`,
    owner: 'operator',
    scope: 'switchboard',
  })
  // The refusal note lingers 10 s (ConcourseRoute noteControl) while this
  // drive's budget is 18 s: the FINAL frame is past the note by design, so
  // the receipt is read from the mark the second '2' carries — the settled
  // frame 0.8 s after the first '2' landed.
  const r4 = drive(
    'leak-both-cards',
    [
      // the pane's card is up on the board; '2' is the Select's own ordinal
      // for 'No' — it answers the PANE's card (deny) and nothing else.
      // The card's grammar is choose-then-confirm ('↑↓ choose · ↵ confirm')
      // and digits do NOT select on this pane card (a probed '2' left the
      // pointer on row 1) — walk the taught grammar exactly: ↓ to row 2,
      // ↵ answers it.
      { atTick: 999, awaitText: 'Do you want to proceed?', minTick: 5, awaitSettleTicks: 3, data: '\u001b[B' },
      // The confirm rides its OWN settled beat: a same-burst arrow+enter
      // answered the row (the check ✔ painted) with the card left standing.
      { atTick: 999, awaitText: 'No — run here as it is', minTick: 2, afterPrevTicks: 6, data: '\r' },
      { afterPrevTicks: 4, data: '2', mark: 'after-first-2' },
    ],
    90,
  )
  const r4Answered = markOf('leak-both-cards', 'after-first-2')
  const noteLine = [...r4Answered, ...r4].find(l => /refused|unknown|already-answered|denied/.test(l)) ?? ''
  check('R4 the pane card ANSWERED (its receipt painted on the strip)', noteLine !== '', r4Answered.filter(l => l.includes('│')).slice(-8).map(l => l.trim().slice(0, 70)).join(' | '))
  check('R4 alpha\'s parked ask is STILL parked (the covered REPL card answered nothing)', await alphaAskOpen())
  check('R4 alpha\'s Bash never ran (no tool result)', !existsSync(join(SCRATCH, 'nothing-here')) && !r4.some(l => l.includes('Tidied')))
  // The seeded row settles here so the reap legs see the plain board.
  for (const o of await obligations.openObligations({ scope: 'switchboard' })) {
    if (o.ref === 'permission:git-init:deadbeef0001') await obligations.resolveObligation(o.obligationId, { kind: 'withdrawn', by: 'prover', scope: 'switchboard' } as never)
  }

  // ── the board order decides which row ↵ enters — read it, then drive ──
  const board = drive('reap-board', [], 40)
  const rowA = board.findIndex(l => l.includes('alpha probe'))
  const rowB = board.findIndex(l => l.includes('beta probe'))
  check('the live board shows both sessions', rowA >= 0 && rowB >= 0, `alpha=${rowA} beta=${rowB}`)
  const firstTitle = rowA >= 0 && (rowB < 0 || rowA < rowB) ? 'alpha probe' : 'beta probe'
  const otherTitle = firstTitle === 'alpha probe' ? 'beta probe' : 'alpha probe'

  // ── R1: enter the first row, back, reap it, step to the focused chat ──
  console.log('R1 reap the focused session — the focused chat is the survivor')
  const r1 = drive(
    'reap-survivor',
    [
      { atTick: 999, awaitText: firstTitle, minTick: 5, awaitSettleTicks: 3, data: '\r' }, // enter the selected row
      { atTick: 999, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT }, // back to the board
      { atTick: 999, awaitText: 'SESSIONS', minTick: 5, awaitSettleTicks: 3, data: '\t' }, // → list region
      { afterPrevTicks: 3, data: 'x' },
      { afterPrevTicks: 2, data: 'x' }, // the double-x within 2s
      { afterPrevTicks: 20, data: SHIFT_RIGHT }, // → the focused chat
    ],
    140,
  )
  const tag1 = tagLine(r1)
  check('R1 the focused chat opened onto a live session (tag bar present)', tag1 !== undefined, r1.filter(l => l.trim()).slice(0, 6).join(' | '))
  check(`R1 …and it is the SURVIVOR (${otherTitle}), never the reaped ${firstTitle}`, tag1 !== undefined && tag1.includes(otherTitle) && !tag1.includes(firstTitle), tag1 ?? '')
  check('R1 the reaped session left the roster', await untilAsync(() => liveIds().length === 1, 15_000), liveIds().join(','))
  const survivorId = liveIds()[0] ?? ''
  check('R1 the roster survivor is the other session', survivorId === (firstTitle === 'alpha probe' ? sidB : sidA))

  // ── R2: reap the last one — the boot menu takes the frame (rule 5) ──
  console.log('R2 reap the last session — the boot menu takes the frame')
  const r2 = drive(
    'reap-last',
    [
      { atTick: 999, awaitText: otherTitle, minTick: 5, awaitSettleTicks: 3, data: '\r' },
      { atTick: 999, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT },
      { atTick: 999, awaitText: 'SESSIONS', minTick: 5, awaitSettleTicks: 3, data: '\t' },
      { afterPrevTicks: 3, data: 'x' },
      { afterPrevTicks: 2, data: 'x' },
      // The frame before this ⇧→ is the settled landing (the menu); the
      // chord then walks to the board — the strip's next present stop.
      { afterPrevTicks: 20, data: SHIFT_RIGHT, mark: 'menu' },
      // The frame before this ⇧→ is the board; with no chat stop left the
      // chord moves nothing — the final frame must still be the board.
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'board' },
    ],
    160,
  )
  const r2Menu = markOf('reap-last', 'menu')
  const r2Board = markOf('reap-last', 'board')
  check('R2 the last release landed the BOOT MENU (the face\'s rows + ready line) — no ghost chat, no root composer', has(r2Menu, 'New Session') && has(r2Menu, '↵ start') && !has(r2Menu, '❯'), r2Menu.filter(l => l.trim()).slice(0, 8).join(' | '))
  check('R2 no session tag bar on the menu (no chat is open)', tagLine(r2Menu) === undefined, tagLine(r2Menu) ?? '')
  check('R2 ⇧→ from the menu is the board (the strip\'s next present stop)', has(r2Board, 'SESSIONS') && tagLine(r2Board) === undefined, r2Board.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 ⇧→ from the board is NO MOVEMENT: the settled frame is still the board — never the dead chat, never a bounce back to the menu', has(r2, 'SESSIONS') && tagLine(r2) === undefined && !has(r2, '↵ start'), r2.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 …and no dead session title anywhere on it', !has(r2, otherTitle) || has(r2, 'SESSIONS'), r2.filter(l => l.includes(otherTitle)).join(' | '))
  check('R2 the roster is empty', await untilAsync(() => liveIds().length === 0, 15_000), liveIds().join(','))

  // ── R3: where ⇧← from the board actually lands after a reap ──
  console.log('R3 the honesty leg — ⇧← from the board')
  const r3 = drive('board-shift-left', [{ atTick: 999, awaitText: 'SESSIONS', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT }], 60)
  const r3Face = has(r3, '↵ start') ? 'the Boot face' : has(r3, 'SESSIONS') ? 'the board (no-op)' : has(r3, '⇧← back') ? 'A SESSION TAG BAR' : 'another surface'
  console.log(`  [INFO] ⇧← from the board lands on: ${r3Face} — first rows: ${r3.filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')}`)
  check('R3 ⇧← from the board never opens a dead session', tagLine(r3) === undefined)
  check('R3 ⇧← from the board lands the Boot face (the strip\'s left stop)', has(r3, '↵ start') && !has(r3, 'SESSIONS'), r3.filter(l => l.trim()).slice(0, 3).join(' | '))
} finally {
  try {
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    const sup = await import('../../src/daemon/concourseSupervisor.ts')
    for (const rec of Object.values(sup.readSessionWorkers(daemonDir))) {
      if (rec.endedAt === undefined) await daemonControlRpc({ op: 'concourseRelease', workerId: rec.workerId } as never).catch(() => undefined)
    }
  } catch {
    /* teardown is best-effort */
  }
  daemon.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 1500))
  if (daemon.exitCode === null) daemon.kill('SIGKILL')
  await api.close()
  rmSync(join(SCRATCH, 'home', 'daemon'), { recursive: true, force: true })
}

console.log(`captures under ${OUT_DIR}`)
console.log(failures === 0 ? 'ALL REAP LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
