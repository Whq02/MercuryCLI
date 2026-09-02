#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-chat-mode-drive.ts — THE PLAIN WORLD on the
//  REAL built bundle through the PTY capture substrate (vshot.py) in seeded
//  scratch homes whose daemons live in those homes.
//  The captures for the
//  operator's strike land in MERCURY_CHATMODE_CAPTURE_DIR.
//
//  L15 (the operator's word): `mercury --chat` BOOTS ON THE BOOT MENU —
//  no session born at boot, no Session Concourse row on the face; ↵ New
//  Session is the door. The felt path is menu → ↵ → chat.
//
//   F1  THE FELT PATH `mercury --chat`: the first paint is the boot menu
//       with NO Session Concourse row and the key-map row "⇧→ no chat
//       open"; nothing was born; ↵ New Session reaches the composer within
//       the one-door budget (the menu's mount warmed the daemon and its
//       runner beneath the face — the daemon log's "warm claim acked" line
//       is the warm road's receipt); exactly ONE session then exists.
//   F2  THE CONTROL: the same road on a bare boot (the fleet world) — the
//       plain world's ↵ is the fleet world's ↵, the same warm claim; both
//       numbers print for the receipt.
//   P1  THE CARD in --chat at 120×40: the landing frame carries New Session
//       · Doctor · Resume and NO "Session Concourse"; after ↵, ⇧← is the
//       same face whose row now reads "⇧→ chat" — still no concourse row.
//   P2  THE CARD at 100×30: the same truths at the second size (the six-row
//       card is a real variant of the composition tiers).
//   P3  `--concourse-off` at 100×30: the face KEEPS the row as its live-view
//       door ("live view only — concourse off") and reads "⇧→ no chat open".
//   P4  THE COMMANDS in --chat: /party answers the router's one sentence
//       (never "Unknown skill", never the generic enablement line);
//       /sessions opens the manager (the plain CLI's own); /status shows the
//       Concourse row "off this boot (--chat)".
//   The ⚑ jump needs a waiting ask to paint; its words are pinned purely in
//   prove-chat-mode-polish §A (a drive cannot honestly manufacture a need).
// ============================================================================
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-chatmode-')))
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
const CAPTURE_DIR = process.env.MERCURY_CHATMODE_CAPTURE_DIR ?? null
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
  console.error(`prove-chat-mode-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [CWD])

/** The face's canon ready line (the boot menu is on screen). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
/** The composer's placeholder (a chat is on screen). */
const COMPOSER = 'Type a prompt'
/** The session manager's footer (the /sessions dialog is on screen). */
const MANAGER_FOOTER = 'n new ·'
/** Ticks the face waits before ↵ so the daemon pre-warm and its warm runner
 *  are up — the felt legs measure the WARM road, the one the rule names. */
const WARM_TICKS = 25
/** The felt-Enter budget in rig ticks (200 ms each) — the one-door drive's. */
const ENTER_BUDGET_TICKS = 3
/** The strip chord bytes, spelled without an escape literal in the source. */
const ESC = String.fromCharCode(27)
const SHIFT_LEFT = `${ESC}[1;2D`

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

async function capture(opts: { id: string; home: string; argv?: string[]; sends: Send[]; ready?: string; total?: number; stableTicks?: number; cols?: number; rows?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5', ...(opts.argv ?? [])],
      cwd: CWD,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
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

type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
function marksOf(c: Capture): Mark[] {
  return (c.payload.marks as Mark[] | undefined) ?? []
}
function markText(c: Capture, label: string): string {
  return (marksOf(c).find(m => m.label === label)?.grid ?? []).map(row => row.map(cell => cell.c).join('')).join('\n')
}
/** The ↵→ready receipt in ms: the LAST send's tick against the readyAt tick
 *  (200 ms granularity — the rig's own clock). */
function enterLatencyMs(c: Capture): number | null {
  const receipts = (c.payload.sendReceipts as Array<{ atTick: number; ts: number }> | undefined) ?? []
  const sent = receipts[receipts.length - 1]
  const readyAt = c.payload.readyAt as number | null | undefined
  if (!sent || readyAt === null || readyAt === undefined) return null
  return (readyAt - sent.atTick) * 200
}

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}
const firstRows = (text: string): string => text.split('\n').slice(0, 6).join(' | ').slice(0, 200)

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
const liveRecords = (home: string): ReturnType<typeof readSessionWorkers> =>
  Object.fromEntries(Object.entries(recordsOf(home)).filter(([, r]) => r.endedAt === undefined))

/** The owned daemon's log (ownedDaemon appends to the project's adoptive
 *  daemon dir; the home's daemon dir is read too so a moved log is found). */
function daemonLogText(home: string): string {
  const candidates = [join(CWD, '.mercury', 'daemon', 'daemon.log'), join(CWD, '.claude', 'daemon', 'daemon.log'), join(home, 'daemon', 'daemon.log')]
  return candidates
    .filter(p => existsSync(p))
    .map(p => `# ${p}\n${readFileSync(p, 'utf8')}`)
    .join('\n')
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

const isFace = (text: string): boolean => text.includes('New Session') && text.includes(READY_LINE)
const isChat = (text: string): boolean => text.includes(COMPOSER) && !text.includes(READY_LINE)
/** The --chat face: the card without its concourse row, the chat absent. */
const isChatFace = (text: string): boolean => isFace(text) && !text.includes('Session Concourse') && text.includes('⇧→ no chat open')

/** The felt ↵ on a face: boot → the face, WARM_TICKS, ↵ → the composer. */
async function feltEnter(id: string, argv: string[]): Promise<{ c: Capture; face: string; ms: number | null; claims: number; log: string }> {
  const home = freshHome(id)
  const c = await capture({
    id,
    home,
    argv,
    sends: [g(READY_LINE, '', { mark: 'face' }), { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }],
    ready: COMPOSER,
    total: 200,
  })
  const log = daemonLogText(home)
  const claims = (log.match(/warm claim acked in (\d+)ms/g) ?? []).length
  const out = { c, face: markText(c, 'face'), ms: enterLatencyMs(c), claims, log }
  ;(out as { home?: string }).home = home
  return out
}

// ── F1: the felt path — `--chat` lands the menu; ↵ is the warm road ─────────
console.log('F1 — mercury --chat: the boot menu lands with no session and no concourse row; ↵ New Session is warm')
let chatMs: number | null = null
{
  const r = await feltEnter('f1-felt-chat', ['--chat'])
  const home = (r as { home?: string }).home!
  printFrame('f1 (--chat: the chat after ↵)', r.c.lines)
  chatMs = r.ms
  console.log(`  [FELT] --chat ↵ → composer ready: ${r.ms === null ? '∅' : `${r.ms} ms`} (budget ${ENTER_BUDGET_TICKS * 200} ms; the rig's tick is 200 ms)`)
  check('F1 the first paint is the boot menu (the face), not a chat — no boot into a chat', isFace(r.face) && !r.face.includes(COMPOSER), firstRows(r.face))
  check('F1 the --chat face carries NO Session Concourse row (New Session is the door) and its key-map row says "⇧→ no chat open"', isChatFace(r.face), r.face.split('\n').filter(l => /Concourse|⇧/.test(l)).join(' | '))
  check(`F1 ↵ reached the composer within the budget (${r.ms ?? '∅'} ms ≤ ${ENTER_BUDGET_TICKS * 200})`, r.ms !== null && r.ms <= ENTER_BUDGET_TICKS * 200, r.c.tail.slice(-200))
  check('F1 the composer is live after ↵', r.c.text.includes(COMPOSER))
  const live = Object.values(liveRecords(home))
  check('F1 exactly ONE session exists — born at ↵, none at boot', live.length === 1 && live[0]?.bornBlankAt !== undefined, JSON.stringify(live.map(x => x.runnerId)))
  check("F1 the ↵ session runs the boot's model (the next-session facts' precedence falls to the screen's main model — the rig's --model)", live[0]?.modelKey === 'claude-sonnet-5', live[0]?.modelKey)
  console.log(`  [WARM] daemon log: ${r.claims} warm claim(s) acked${r.claims > 0 ? ` — ${(r.log.match(/warm claim acked in \d+ms/) ?? [''])[0]}` : ''}`)
  check('F1 THE WARM ROAD: the ↵ birth claimed the runner the menu\'s mount pre-warmed beneath the face', r.claims >= 1, r.log.split('\n').filter(l => /warm|claim|self-warm/i.test(l)).slice(-6).join(' | ').slice(0, 400))
  reapHome(home)
}

// ── F2: the control — the fleet world's face and the same felt ↵ ────────────
console.log('F2 — the control: a bare boot\'s face and the felt ↵ (the fleet world\'s first answer)')
{
  const r = await feltEnter('f2-control', [])
  const home = (r as { home?: string }).home!
  printFrame('f2 (the chat after ↵)', r.c.lines)
  console.log(`  [FELT] bare ↵ → composer ready: ${r.ms === null ? '∅' : `${r.ms} ms`} · --chat ↵: ${chatMs ?? '∅'} ms (budget ${ENTER_BUDGET_TICKS * 200} ms each)`)
  check('F2 the bare boot landed on the face first, with its concourse row', isFace(r.face) && r.face.includes('Session Concourse'), firstRows(r.face))
  check(`F2 ↵ reached the composer within the budget (${r.ms ?? '∅'} ms ≤ ${ENTER_BUDGET_TICKS * 200})`, r.ms !== null && r.ms <= ENTER_BUDGET_TICKS * 200, r.c.tail.slice(-200))
  check('F2 the plain world\'s first answer is the fleet world\'s: both ↵ within the one budget', chatMs !== null && r.ms !== null && chatMs <= ENTER_BUDGET_TICKS * 200 && r.ms <= ENTER_BUDGET_TICKS * 200)
  reapHome(home)
}

// ── P1/P2: the card in --chat, both sizes ───────────────────────────────────
for (const size of [
  { id: 'p1', cols: 120, rows: 40 },
  { id: 'p2', cols: 100, rows: 30 },
]) {
  console.log(`${size.id.toUpperCase()} — the --chat card at ${size.cols}×${size.rows}: no concourse row, New Session the door, the chat to the right after ↵`)
  const home = freshHome(`card-${size.id}`)
  const c = await capture({
    id: `${size.id}-card-chat-${size.cols}x${size.rows}`,
    home,
    argv: ['--chat'],
    cols: size.cols,
    rows: size.rows,
    sends: [
      g(READY_LINE, '', { mark: 'landing', awaitSettleTicks: 4 }),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, SHIFT_LEFT, { mark: 'chat', awaitSettleTicks: 4 }),
      { afterPrevTicks: 8, data: '', mark: 'face-again' },
    ],
    stableTicks: 4,
    total: 240,
  })
  const landing = markText(c, 'landing')
  const again = markText(c, 'face-again')
  printFrame(`${size.id} (the --chat landing, ${size.cols}×${size.rows})`, landing.split('\n'))
  check(`${size.id.toUpperCase()} the landing is the face with New Session · Doctor · Resume`, isFace(landing) && landing.includes('Doctor') && landing.includes('Resume Session'), firstRows(landing))
  // The --chat card = the full card minus its concourse row (L24(6-
  // SUPERSEDED), the identical-worlds law): seven rows at most since the
  // MCPs & Skills row joined every face — the row itself is pinned by
  // scripts/ui/prove-kit-menu.ts on both hosts in both worlds.
  check(`${size.id.toUpperCase()} NO "Session Concourse" row on the --chat card (seven rows at most); the key-map row says "⇧→ no chat open"`, isChatFace(landing), landing.split('\n').filter(l => /Concourse|⇧|live view/i.test(l)).join(' | '))
  check(`${size.id.toUpperCase()} ↵ births the chat`, isChat(markText(c, 'chat')), firstRows(markText(c, 'chat')))
  check(`${size.id.toUpperCase()} ⇧← from the chat is the same face — still no concourse row — whose row now names the chat ("⇧→ chat")`, isFace(again) && !again.includes('Session Concourse') && again.includes('⇧→ chat') && !again.includes('⇧→ concourse'), again.split('\n').filter(l => /Concourse|⇧/.test(l)).join(' | '))
  reapHome(home)
}

// ── P3: --concourse-off at the second size keeps the row ────────────────────
console.log('P3 — --concourse-off at 100×30: the face keeps the row as its live-view door')
{
  const home = freshHome('off-small')
  const c = await capture({
    id: 'p3-concourse-off-100x30',
    home,
    argv: ['--concourse-off'],
    cols: 100,
    rows: 30,
    sends: [g(READY_LINE, '', { mark: 'face', awaitSettleTicks: 4 })],
    ready: READY_LINE,
    stableTicks: 4,
    total: 120,
  })
  printFrame('p3 (--concourse-off, 100×30)', c.lines)
  check('P3 the switch boot landed the face', isFace(c.text), firstRows(c.text))
  check('P3 the face KEEPS the Session Concourse row as the live-view door ("live view only — concourse off")', c.text.includes('Session Concourse') && c.text.includes('live view only') && c.text.includes('concourse off'), c.lines.filter(l => /live|concourse/i.test(l)).join(' | '))
  check('P3 with no chat the key-map row says "⇧→ no chat open" — no concourse stop, no chat yet', c.text.includes('⇧→ no chat open'), c.lines.filter(l => l.includes('⇧')).join(' | '))
  reapHome(home)
}

// ── P4: the commands in --chat ──────────────────────────────────────────────
console.log('P4 — --chat: /party answers the sentence, /sessions opens, /status says the world')
{
  const home = freshHome('commands')
  const c = await capture({
    id: 'p4-commands-chat',
    home,
    argv: ['--chat'],
    sends: [
      g(READY_LINE, ''),
      { afterPrevTicks: WARM_TICKS, data: '\r' },
      g(COMPOSER, '/party', { awaitSettleTicks: 4 }),
      { afterPrevTicks: 3, data: '\r' },
      { afterPrevTicks: 2, data: '\r' },
      g('opens a Session Concourse surface', '', { mark: 'party', awaitSettleTicks: 3 }),
      { afterPrevTicks: 3, data: '/sessions' },
      { afterPrevTicks: 3, data: '\r' },
      g(MANAGER_FOOTER, '', { mark: 'sessions', awaitSettleTicks: 3 }),
      { afterPrevTicks: 2, data: ESC },
      { afterPrevTicks: 4, data: '/status' },
      { afterPrevTicks: 3, data: '\r' },
      g('off this boot (--chat)', '', { mark: 'status', awaitSettleTicks: 3 }),
      // A mark snapshots BEFORE its own send's bytes are written (the rig's
      // pre-key-frame law): the closed frame rides a follow-up empty send
      // gated on the composer, after the esc.
      { afterPrevTicks: 2, data: ESC },
      g(COMPOSER, '', { mark: 'closed', awaitSettleTicks: 3 }),
    ],
    stableTicks: 6,
    total: 320,
  })
  printFrame('p4 (after the three commands)', c.lines)
  const party = markText(c, 'party')
  // The transcript WRAPS the sentence across rows and renders the markdown
  // backticks away - the check reads the frame FLAT (borders stripped,
  // whitespace squashed), never the source spelling.
  const partyFlat = party.split('\n').map(l => l.replace(/[│╭╮╰╯]/g, ' ').trim()).join(' ').replace(/ +/g, ' ')
  check('P4 /party typed in the plain world answers the router\'s sentence (off in this boot (--chat), a plain boot has it)', partyFlat.includes('The /party command opens a Session Concourse surface') && partyFlat.includes('the Session Concourse is off in this boot (--chat)') && partyFlat.includes('a plain mercury boot has it.'), party.split('\n').filter(l => /party|Concourse/i.test(l)).join(' | ').slice(0, 300))
  check('P4 POISON absent: never "Unknown skill", never the generic enablement line, no crash', !c.text.includes('Unknown skill') && !c.text.includes('exists but is not enabled') && !c.text.includes('Mercury exited on an error'))
  check('P4 /sessions opens the session manager (the plain CLI\'s own — not gated with the concourse)', markText(c, 'sessions').includes(MANAGER_FOOTER), firstRows(markText(c, 'sessions')))
  check('P4 /status carries the Concourse row: "off this boot (--chat)" with the way back', markText(c, 'status').includes('off this boot (--chat)') && markText(c, 'status').includes('a plain `mercury` boot has it'), markText(c, 'status').split('\n').filter(l => /Concourse/i.test(l)).join(' | ').slice(0, 300))
  check('P4 the chat is still the frame after the dialogs close (the composer is live on the post-esc frame itself)', markText(c, 'closed').includes(COMPOSER), firstRows(markText(c, 'closed')))
  reapHome(home)
}

if (process.env.MERCURY_CHATMODE_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-chat-mode-drive: ALL LAWS HOLD' : `\nprove-chat-mode-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
