#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-cap-offer-live.ts — the usage-cap offer on the REAL
//  binary: a ChatGPT-subscription session on a loopback Responses fixture
//  whose answers carry the 5h window NEAR ITS CAP, the neutral failover offer
//  over the composer, enter → the transition preview, enter → the seat
//  switches to the Anthropic lane, the switched turn dispatches to the
//  Anthropic loopback — and the offer never paints again.
//
//  THE SIGHTING: the offer looped — offer → preview → confirm → offer,
//  forever — and the switch never applied. The owner-level prover
//  (scripts/providers/prove-cap-offer-settles.ts) pins WHY (the armed state
//  keyed on a jittering reset moment) and the fix; this journey pins the
//  ROAD on the built bundle, both loopback families, driven through a PTY:
//
//    L1  the GPT leg runs (the subscription Responses fixture answers, its
//        reply paints, its usage headers arm the offer)
//    L2  the offer paints ONCE, naming the OpenAI window and the exact
//        target id the seat persists
//    L3  ↵ opens the transition preview (the plan, the settlement owner)
//    L4  ↵ settles: the seat switches on the real bundle (the chip), the
//        next turn DISPATCHES to the Anthropic wire with the target id
//    L5  the offer does not re-paint after the settlement
//    L6  the switched reply paints
//    E1  Esc on the offer stays put: the next GPT turn (the same wall
//        re-observed, its reset shifted) paints its reply and the offer
//        does NOT re-paint; the session stays on its GPT seat
//
//  The fixture is a SEPARATE process hosted under node
//  (cap-offer-fixture-server.ts); the display pins ride the child env.
//
//  Run: ~/.bun/bin/bun run scripts/journey/prove-cap-offer-live.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

// Contract data shared with cap-offer-fixture-server.ts (kept in both files —
// the server cannot be imported without starting it).
const GPT_REPLY = 'sol answers from the fixture'
const GPT_REPLY_AGAIN = 'sol answers again from the fixture'
const FABLE_REPLY = 'fable picked up the handoff'
/** The exact id the seat persists for the newest first-party frontier member. */
const TARGET_ID = 'claude-fable-5-1'
/** The band's chip during the settle: the switched name with the live dot. */
const TARGET_CHIP = 'Fable 5.1 · ●'
/** The idle band's chip for the home seat: the name and its separator (the
 *  dot after it is the effort word's, not the live dot). */
const HOME_CHIP = 'GPT-5.6 Sol ·'
const OFFER_TITLE = 'OpenAI usage window'

// ── the hermetic world ──────────────────────────────────────────────────────
const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-capoffer-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-capoffer-probe-key'
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(FIXTURE_CWD, { recursive: true })
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
// The OpenAI SUBSCRIPTION sign-in — the usage bands ride the subscription
// wire only. A stored token set the reader takes verbatim, fresh far ahead
// so no refresh reaches any wire.
writeFileSync(
  path.join(RUN_HOME, '.openai-auth.json'),
  JSON.stringify({
    version: 1,
    tokens: {
      idToken: 'fixture-id-token',
      accessToken: 'fixture-access-token',
      refreshToken: 'fixture-refresh-token',
      accountId: 'acct_fixture',
      planType: 'plus',
      email: 'sam@example.test',
      accessTokenExpiresAtMs: Date.now() + 24 * 3600_000,
    },
  }),
)
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# cap offer drive fixture\n')

// ── the fixture server (its own process, under node — see the header) ──────
const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn('node', [path.join(import.meta.dir, 'cap-offer-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  // A red run KEEPS the world for forensics (the path prints below).
  if (failures === 0) {
    try {
      rmSync(RUN_HOME, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`[forensics] world kept: ${RUN_HOME}`)
  }
}
process.on('exit', reap)

console.log('============================================================')
console.log(' cap offer LIVE — the real binary, both loopback families')
console.log('============================================================')

// ── the PTY drive ───────────────────────────────────────────────────────────
/** A scripted keystroke. `requireAwait` makes the send fire ONLY on its
 *  await (never blind at a deadline — a card that rises late on a busy box
 *  still gets its key); `afterPrevTicks` schedules relative to the previous
 *  send's actual fire tick. The capture ends early once every send is done
 *  and the grid is stable, so a generous `total` costs nothing when fast. */
type Send = {
  atTick?: number
  minTick?: number
  afterPrevTicks?: number
  requireAwait?: boolean
  awaitText?: string
  awaitSettleTicks?: number
  data: string
  mark?: string
}
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
type Payload = {
  grid: Array<Array<{ c: string }>>
  sendReceipts?: Array<{ atTick?: number; ts?: number }>
  marks?: Mark[]
  endReason?: string
}
type Capture = { kind: string; method?: string; url?: string; body?: Record<string, unknown>; call?: number; at: number }

const gridText = (grid: Array<Array<{ c: string }>>): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_OPERATOR: 'sam',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
  MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
  MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
  MERCURY_TABULA_MINERVA: '0',
  MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
}
delete childEnv.NODE_ENV
delete childEnv.ANTHROPIC_AUTH_TOKEN
// The subscription is the ONLY OpenAI source (a key beside it would be the
// slot rung's business, not this offer's); the posture stays the default.
delete childEnv.OPENAI_API_KEY
delete childEnv.MERCURY_CAP_FAILOVER
delete childEnv.MERCURY_MOCK_LIMITS
delete childEnv.MERCURY_MOCK_USAGE_PAYLOAD

function readCaptures(): Capture[] {
  return readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
}

function drive(name: string, sends: Send[], opts: { total: number; readyText?: string[] }): { payload: Payload | null; wire: Capture[]; status: number | null } {
  const before = readCaptures().length
  const out = path.join(RUN_HOME, `grid-${name}.json`)
  const cfg = {
    argv: ['node', DIST, '--model', 'gpt-5.6-sol'],
    cwd: FIXTURE_CWD,
    sends,
    ...(opts.readyText ? { readyText: opts.readyText } : {}),
    stableTicks: 4,
    total: opts.total,
    cols: 110,
    rows: 34,
    out,
  }
  const cfgPath = path.join(RUN_HOME, `cfg-${name}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(240_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
  return { payload, wire: readCaptures().slice(before), status: res.status }
}

const markGrid = (payload: Payload | null, label: string): string => {
  const mark = payload?.marks?.find(m => m.label === label)
  return mark ? gridText(mark.grid) : ''
}
const receiptTick = (payload: Payload | null, index: number): number => payload?.sendReceipts?.[index]?.atTick ?? -1

// ── leg 1: the offer settles ───────────────────────────────────────────────
// Sends (in order; every gate STRICT — it fires on its await, never blind):
//   [0] ↵ on New Session (the bare boot lands on the Boot face)
//   [1] the GPT turn
//   [2] ↵ on the offer (the card arms enter after mount — settle first)
//   [3] ↵ on the transition preview
//   [4] the pickup ask once the chip shows the switched seat
//   [5] the NO-REPAINT PROBE: fires on the offer title if it ever returns,
//       else PROBE_GAP ticks after the pickup (its deadline) — an early fire
//       is the card re-painting
const PROBE_GAP = 60
const legSettle = drive(
  'settle',
  [
    { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 20, data: 'hello sol\r' },
    { requireAwait: true, awaitText: OFFER_TITLE, minTick: 10, awaitSettleTicks: 4, data: '\r', mark: 'offer' },
    { requireAwait: true, awaitText: 'Model switch preview', minTick: 8, awaitSettleTicks: 2, data: '\r', mark: 'preview' },
    { requireAwait: true, awaitText: TARGET_CHIP, minTick: 10, awaitSettleTicks: 2, data: 'pick up from gpt pls\r', mark: 'switched' },
    { afterPrevTicks: PROBE_GAP, awaitText: OFFER_TITLE, data: '', mark: 'probe' },
  ],
  { total: 900 },
)
{
  const p = legSettle.payload
  const wire = legSettle.wire
  const finalGrid = p ? gridText(p.grid) : ''
  section('L1 — the GPT leg ran on the subscription fixture and its reply painted')
  const gptCalls = wire.filter(c => c.kind === 'openai')
  check('the Responses fixture served the GPT turn', gptCalls.length >= 1, `openai calls=${gptCalls.length} vshot status=${legSettle.status} hits=${wire.map(c => `${c.kind}:${c.url ?? ''}`).join('|') || 'NONE'}`)
  check('the GPT turn rode the ChatGPT-subscription base (the usage bands\' wire)', gptCalls.some(c => (c.url ?? '').includes('/chatgpt/')), gptCalls.map(c => c.url).join(','))
  const offerTick = receiptTick(p, 2)
  check('the offer send fired on its await (the reply painted and the bands armed the offer)', offerTick > 0, `offer send at tick ${offerTick}; endReason=${p?.endReason ?? '?'}`)

  section('L2 — the offer paints ONCE: the OpenAI window named, the exact target id')
  const offerGrid = markGrid(p, 'offer')
  check('the offer card stood over the composer when enter was sent', offerGrid.includes(OFFER_TITLE), offerGrid.split('\n').slice(-14).join('\n'))
  check('the card names the binding window in the wire\'s own words (no second "window")', offerGrid.includes('approaching the OpenAI 5h window') && !offerGrid.includes('5h window window'))
  check(`the card offers the exact id the seat persists (⇄ ${TARGET_ID})`, offerGrid.includes(`⇄ ${TARGET_ID}`))
  check('the one true hint line: enter opens the preview, esc stays put', offerGrid.includes('enter opens the transition preview') && offerGrid.includes('stays put'))

  section('L3 — ↵ opens the transition preview (the plan, the settlement owner)')
  const previewGrid = markGrid(p, 'preview')
  check('the preview card stood when the confirm was sent', previewGrid.includes('Model switch preview'), previewGrid.split('\n').slice(-14).join('\n'))
  check('the preview names the move to the target and its plan', previewGrid.includes('Fable 5.1') && previewGrid.includes('plan ') && previewGrid.includes('settlement owner'))
  check('the offer card is gone while the preview stands (the cards never stack)', !previewGrid.includes(OFFER_TITLE))

  section('L4 — ↵ settles: the seat switches on the real bundle, the next turn dispatches to the Anthropic wire')
  const switchedTick = receiptTick(p, 4)
  check('the chip flipped to the switched seat (the pickup send fired on its await)', switchedTick > 0, `pickup send at tick ${switchedTick}; endReason=${p?.endReason ?? '?'}`)
  const anthropicCalls = wire.filter(c => c.kind === 'anthropic')
  const main = anthropicCalls.find(c => Array.isArray(c.body?.tools) && (c.body?.tools as unknown[]).length > 0 && JSON.stringify(c.body ?? {}).includes('pick up from gpt pls'))
  check('the Anthropic loopback received the switched request (dispatch FIRED through the settlement)', main !== undefined, `anthropic calls=${anthropicCalls.length}`)
  check(`the switched request targets the exact id (${TARGET_ID})`, String(main?.body?.model ?? '').startsWith(TARGET_ID), String(main?.body?.model))
  check('the GPT-leg history rides the switched request', main !== undefined && JSON.stringify(main.body).includes('hello sol'))

  section('L5 — the offer does not re-paint after the settlement')
  const probeTick = receiptTick(p, 5)
  check('the no-repaint probe fired on its DEADLINE, never on its await (the card never returned)', switchedTick > 0 && probeTick >= switchedTick + PROBE_GAP - 1, `probe fired at tick ${probeTick} (pickup at ${switchedTick}, gap ${PROBE_GAP})`)
  const switchedGrid = markGrid(p, 'switched')
  check('no offer card on the switched screen', !switchedGrid.includes(OFFER_TITLE))
  check('no offer card on the final screen', !finalGrid.includes(OFFER_TITLE) && !finalGrid.includes('Model switch preview'))

  section('L6 — the switched reply painted')
  check('the Anthropic reply painted', finalGrid.includes(FABLE_REPLY) || markGrid(p, 'probe').includes(FABLE_REPLY), finalGrid.split('\n').slice(-12).join('\n'))
}

// ── leg 2: Esc stays put ───────────────────────────────────────────────────
//   [0] ↵ on New Session · [1] the GPT turn · [2] Esc on the offer
//   [3] a second GPT turn once the composer is back (the fixture re-observes
//       the SAME wall with its reset shifted — the jitter)
//   [4] the NO-REPAINT PROBE (deadline-fired)
const legEsc = drive(
  'esc',
  [
    { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 20, data: 'hello sol\r' },
    { requireAwait: true, awaitText: OFFER_TITLE, minTick: 10, awaitSettleTicks: 3, data: '\x1b', mark: 'esc' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 8, awaitSettleTicks: 2, data: 'again please\r', mark: 'again' },
    { afterPrevTicks: PROBE_GAP, awaitText: OFFER_TITLE, data: '', mark: 'probe' },
  ],
  { total: 900 },
)
{
  const p = legEsc.payload
  const wire = legEsc.wire
  const finalGrid = p ? gridText(p.grid) : ''
  section('E1 — Esc on the offer stays put; the same wall re-observed never re-opens it')
  const escGrid = markGrid(p, 'esc')
  check('the offer card stood when esc was sent', escGrid.includes(OFFER_TITLE), escGrid.split('\n').slice(-14).join('\n'))
  const againTick = receiptTick(p, 3)
  check('esc dismissed the card and the composer came back (the second turn fired on its await)', againTick > 0, `again send at tick ${againTick}; endReason=${p?.endReason ?? '?'}`)
  const gptCalls = wire.filter(c => c.kind === 'openai')
  check('the second GPT turn ran on the same seat (two Responses calls, no Anthropic call)', gptCalls.length >= 2 && !wire.some(c => c.kind === 'anthropic'), `openai=${gptCalls.length} anthropic=${wire.filter(c => c.kind === 'anthropic').length}`)
  const probeTick = receiptTick(p, 4)
  check('the same wall re-observed with a shifted reset did NOT re-paint the answered offer (the probe fired on its deadline)', againTick > 0 && probeTick >= againTick + PROBE_GAP - 1, `probe fired at tick ${probeTick} (again at ${againTick}, gap ${PROBE_GAP})`)
  check('the second reply painted', finalGrid.includes(GPT_REPLY_AGAIN) || markGrid(p, 'probe').includes(GPT_REPLY_AGAIN), finalGrid.split('\n').slice(-12).join('\n'))
  check('the session stayed on its GPT seat', finalGrid.includes(HOME_CHIP) && !finalGrid.includes('Fable 5.1'), finalGrid.split('\n').filter(l => l.includes('·')).slice(-3).join('\n'))
  check('no offer card on the final screen', !finalGrid.includes(OFFER_TITLE))
}

if (failures > 0) {
  try {
    const debugDir = path.join(RUN_HOME, 'debug')
    if (existsSync(debugDir)) {
      const latest = readdirSync(debugDir)
        .filter(f => f.endsWith('.txt'))
        .sort()
        .at(-1)
      if (latest) {
        const tail = readFileSync(path.join(debugDir, latest), 'utf8')
          .split('\n')
          .filter(l => !l.includes('High write ratio'))
          .slice(-30)
          .join('\n')
        console.log(`\n[forensics] debug log tail:\n${tail}`)
      }
    }
  } catch {
    /* forensics best-effort */
  }
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
