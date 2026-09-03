#!/usr/bin/env bun
// ============================================================================
//  prove-contract-offer-drive — the contract offer answers from the KEYBOARD
//  and its No leg BIRTHS (ledger T2: "No/esc births exactly as this key
//  always did"), driven on the built bundle.
//
// THE FIND (the two-session drive): n raised the card,
//  esc CANCELLED the birth — the screen's list region shadowed every key
//  beneath the card (↑↓ board-move · ↵ enterSession · esc exitToRepl), so
//  no keyboard answer could reach it and the operator's next words landed
//  in the OLD chat. The fix: the screen yields whole while the ask stands
//  (the seat/git cards' one-Select law).
//
//  §1 one session lives; ⇧← to the board; n raises the card (frame). §2 esc
//  answers No THROUGH THE CARD — a SECOND session births (the board's live
//  count reads 2, a second row paints). POISON: the pre-fix world left 1
//  live and landed the chat instead.
//
//  §4–§5 THE CARD OWNS ITS TEXT FIELD (ledger L25, the operator's morning
//  report): back on the board, n raises the card again and ↵ takes its Yes
//  — the card STAYS and opens "What is the contract?" INSIDE its own frame;
//  the words type into the card; ↵ births a THIRD session under them (the
//  record carries contract.text). POISON: the pre-fix Yes CLOSED the card
//  and routed the words to the live composer beneath the FIRST session's
//  transcript (the sibling's answer painted behind the compose) — no
//  transcript sentence paints while the card stands, and the retired
//  "write the contract here" context line never paints.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'contract-offer-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'contract-offer-cwd-')))
const configDir = join(home, '.mercury')
const daemonDir = join(home, 'daemon')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
  }),
)
// The first session's answer is a sentence long enough that no board cell
// paints its TAIL whole (the NOW cell truncates) — the tail is the needle
// that only a TRANSCRIPT paint can carry (§4's sibling-transcript poison).
const FIRST_ANSWER = 'The first session answered with a sentence long enough that only a transcript paints its tail whole.'
const TRANSCRIPT_TAIL = /paints its tail whole/
const api = await startFixtureApi([
  { kind: 'text', text: FIRST_ANSWER, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const N = '↑↓ choose'
const CONTRACT_WORDS = 'Ship the widget; touch nothing else.'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1200, '\r'), // 0 New Session → session 1
  after(3600, 'first words here'), // 1
  after(4200, '\r'), // 2 → a settled turn (the row has a title)
  after(7000, `${ESC}[1;2D`), // 3 ⇧← the board
  after(8000, '\t'), // 4 → list
  after(8800, 'n'), // 5 the New Session tab → the contract offer card
  after(10200, ESC), // 6 esc = "No, start it plain" → the SECOND birth
  // The second birth lands its chat by ~+2500 (§2's own frame); the next
  // chord waits a full second past that so it never races the landing.
  // The board comes back in the LIST region: the capsule restores the region
  // the board was left from, and the n that raised the first card fired from
  // the list — a tab here would move on to the live composer and the next
  // keys would type a prompt into the first session instead.
  after(13600, `${ESC}[1;2D`), // 7 ⇧← the board again (from the new chat) — the list, by the capsule
  after(15400, 'n'), // 8 the New Session tab → the card again
  after(16600, '\r'), // 9 ↵ = "Yes — write it here" (the focused first row) → the field opens IN the card
  after(17600, CONTRACT_WORDS), // 10 the words, typed into the card's own field
  after(19000, '\r'), // 11 ↵ births the THIRD session under the words
]
const WALL_S = driveWallSeconds(sends, { tailMs: 2500 }) // the last grab is at(11) + 2500
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
      // env drops the job-wide knob and ptydrive falls back to scale 1 -
      // authored-time sends race 3x-slow hosted boots (the undelivered-sends
      // class; gate run 3's arena zero-observation shapes). Forward it.
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_SPLASH: 'off',
      MERCURY_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
    },
  },
)
let driverOut = ''
child.stdout.on('data', d => (driverOut += d))
child.stderr.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WALL_S * 1000) + 22_000)
await driverClosed(child)
clearTimeout(killer)
await api.close()
const reaped: number[] = []
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM'); reaped.push(rec.pid) } catch {} }
  }
  const supFile = join(daemonDir, 'supervisor.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM'); reaped.push(pid) } catch {} }
  }
} catch {}
console.log(`  reaped pids: ${reaped.join(',') || 'none live'}`)

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
check('the drive ladder fired whole', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)
if (sendRecs.length === sends.length) {
  const at = (i: number): number => Math.round(sendRecs[i]!.sent! - firstOut)
  const res = spawnSync(
    '/usr/bin/python3',
    [
      join(REPO, 'scripts', 'streaming', 'screengrab.py'),
      drive,
      '120',
      '40',
      String(at(2) + 3000), // the first chat, its answer settled (the transcript needle's own proof)
      String(at(5) + 900), // the card
      String(at(6) + 2500), // after esc: the second (blank) chat
      String(at(9) + 900), // after Yes: the field open INSIDE the card
      String(at(10) + 900), // the words typed into the card
      String(at(11) + 2500), // after ↵: the third chat
      '-1',
    ],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const [firstChat, cardFrame, afterEsc, fieldFrame, typedFrame, afterBirth, fin] = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens.map(s => s.rows.join('\n'))
  check('§0 the transcript needle paints in the first chat (the sibling-transcript poison is never vacuous)', TRANSCRIPT_TAIL.test(firstChat!), firstChat!.split('\n').find(r => /answered/.test(r))?.trim().slice(0, 110) ?? '')
  check('§1 the n tab raises the offer card in the live-view pane', /Start with a contract\?/.test(cardFrame!) && /No, start it plain \(esc\)/.test(cardFrame!))
  // The No leg lands the NEW chat focused — n's own meaning before the ask
  // existed ("a blank session born …, the chat focused"). The pre-fix
  // escape road ALSO landed a chat — the OLD one, its transcript carrying
  // the first session's words; the blank tag + the absent words are the
  // discriminator.
  check('§2 esc answers No THROUGH THE CARD — the NEW blank chat is focused (stage-1 tag)', /new session ·/.test(afterEsc!) && /· ready/.test(afterEsc!), (afterEsc ?? '').split('\n').find(r => /· ready|new session/.test(r))?.trim().slice(0, 110) ?? '')
  check("§2c POISON: it is never the OLD chat (the pre-fix esc landed the first session's transcript)", !/first words here/.test(afterEsc!))
  // §4 THE CARD OWNS ITS FIELD (L25): ↵ on the card's Yes keeps the card
  // standing and opens the question INSIDE it; the pre-fix world closed
  // the card, painted the FIRST session's transcript in the pane and put
  // the compose context under the live box — the sibling's answer tail
  // and the retired context line are the two poisons.
  check('§4 ↵ on Yes opens "What is the contract?" INSIDE the standing card', /What is the contract\?/.test(fieldFrame!) && /Start with a contract\?/.test(fieldFrame!), fieldFrame!.split('\n').filter(r => /contract|❯|Start with|What is/i.test(r)).map(r => r.trim().slice(0, 100)).join(' | '))
  check("§4b POISON: no sibling transcript paints behind the card (the first session's answer tail is absent)", !TRANSCRIPT_TAIL.test(fieldFrame!) && !TRANSCRIPT_TAIL.test(typedFrame!))
  check('§4c POISON: the retired live-composer context line never paints', !/write the contract here/.test(fieldFrame!) && !/write the contract here/.test(typedFrame!))
  check('§4d the words type INTO the card (the frame carries them with the question still standing)', /Ship the widget/.test(typedFrame!) && /What is the contract\?/.test(typedFrame!))
  check('§4e the field advertises its keys truthfully (↵ starts · esc plain)', /↵ starts the session under it/.test(typedFrame!) && /esc starts it plain/.test(typedFrame!))
  // §5 ↵ births the THIRD session under the words — the new blank chat is
  // focused (the same landing the No leg takes) and the record carries the
  // contract as a draft the agent acknowledges through its own tool.
  check('§5 ↵ births under the words — the NEW blank chat is focused (stage-1 tag)', /new session ·/.test(afterBirth!) && /· ready/.test(afterBirth!), (afterBirth ?? '').split('\n').find(r => /· ready|new session/.test(r))?.trim().slice(0, 110) ?? '')
  check('§5b POISON: the birth never lands the OLD chat', !/first words here/.test(afterBirth!) && !TRANSCRIPT_TAIL.test(afterBirth!))
  check('§2b/§5c the rows join the board (the final frame)', /new session/.test(fin!) || /3 live/.test(fin!))
  const workers = existsSync(join(daemonDir, 'concourse-workers.json')) ? (JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers?: Record<string, { endedAt?: number; contract?: { text?: string; status?: string } }> }) : { workers: {} }
  const live = Object.values(workers.workers ?? {}).filter(w => w.endedAt === undefined)
  check('§3 the records agree: THREE live sessions (two plain births, one under its contract)', live.length === 3, `${live.length}`)
  const contracted = live.filter(w => w.contract !== undefined)
  check("§5d exactly ONE record carries the contract — the card's words verbatim, drafted for the agent's ack", contracted.length === 1 && contracted[0]?.contract?.text === CONTRACT_WORDS && contracted[0]?.contract?.status === 'draft', JSON.stringify(contracted.map(w => w.contract)))
}
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-contract-offer-drive: ALL LAWS HOLD' : `\nprove-contract-offer-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
