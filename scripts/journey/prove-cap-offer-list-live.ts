#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-cap-offer-list-live.ts — the usage-cap offer's LIST
//  and its BINDING window on the REAL binary, both loopback families plus the
//  key lanes, driven through a PTY (the sibling of prove-cap-offer-live.ts,
//  which pins the single-target road).
//
//    LIST (an OpenAI-subscription home whose 5h window nears its cap; the
//    Anthropic lane at its own cap through the fixture limits seam; Z.AI and
//    DeepSeek keys signed in):
//      L1  the offer lists EVERY other signed-in family with a row to land on
//          — the family, the exact landing row, its usage state — in the
//          sign-in order, the lane at its own cap LAST and marked
//      L2  ↓ moves the highlight on the real card (the cursor, the subtitle)
//      L3  the highlight on the at-cap row: the guide never advertises enter,
//          and ↵ there is INERT — the card stands, no preview opens
//      L4  ↑ back to a usable row; ↵ opens the transition preview for THAT
//          row (not the first); ↵ settles on it — the seat's model reads the
//          chosen row, the next turn dispatches to that lane's wire
//      L5  the offer never re-paints after the settlement
//    POOL (an Anthropic-subscription home on a Fable seat; a fixture usage
//    response through MERCURY_MOCK_USAGE_PAYLOAD carrying seven_day_fable at
//    87% beside a calm 5h/7d; the window observed through the limits seam):
//      P1  the offer fires on the BINDING window — the Fable pool — and card
//          one names it in the usage owner's words ('Fable limit')
//      P2  ↵ settles on the highlighted row (no lossy history ⇒ no preview):
//          the next turn dispatches to that lane's wire
//
//  Deterministic under the capture laws: the display pins ride the child
//  env, every send fires on its own await with atTick as the hard deadline,
//  the card's enter is armed by a settle before it is pressed, the fixture is
//  its own node process, MERCURY_CREDENTIAL_STORE=file with MERCURY_OPERATOR=
//  sam, never a real credential.
//
//  Run: ~/.bun/bin/bun run scripts/journey/prove-cap-offer-list-live.ts
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
const ZAI_REPLY = 'glm picked up the handoff'
const DEEPSEEK_REPLY = 'deepseek picked up the handoff'
/** The key lanes' recorded frontier rows (their pin tables' first rows). */
const ZAI_ROW = 'glm-5.3'
const DEEPSEEK_ROW = 'deepseek-v4-pro'
const FABLE_51 = 'claude-fable-5-1'
const OPENAI_OFFER_TITLE = 'OpenAI usage window'
const ANTHROPIC_OFFER_TITLE = 'Anthropic usage window'

// ── the hermetic worlds ─────────────────────────────────────────────────────
const ROOT_TMP = path.join(realpathSync(tmpdir()), `mercury-capoffer-list-${process.pid}`)
rmSync(ROOT_TMP, { recursive: true, force: true })
const PROBE_KEY = 'sk-ant-capoffer-list-probe-key'

function seedWorld(name: string, opts: { openaiSubscription: boolean; claudeSubscription: boolean; anthropicKeyApproved: boolean }): { home: string; cwd: string } {
  const home = path.join(ROOT_TMP, name)
  const cwd = path.join(home, 'fixture-repo')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    path.join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      ...(opts.anthropicKeyApproved ? { customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] } } : {}),
    }),
  )
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({}))
  if (opts.openaiSubscription) {
    // The OpenAI SUBSCRIPTION sign-in — the usage bands ride the subscription
    // wire only; fresh far ahead so no refresh reaches any wire.
    writeFileSync(
      path.join(home, '.openai-auth.json'),
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
  }
  if (opts.claudeSubscription) {
    // The Claude SUBSCRIPTION sign-in in the file credential store: the
    // scopes the subscriber gate reads, a Max 20x tier, fresh far ahead.
    writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-claude-access-token',
          refreshToken: 'fixture-claude-refresh-token',
          expiresAt: Date.now() + 24 * 3600_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    )
  }
  writeFileSync(path.join(cwd, 'README.md'), '# cap offer list drive fixture\n')
  return { home, cwd }
}

// ── the fixture server (its own process, under node) ───────────────────────
const captureFile = path.join(ROOT_TMP, 'wire-captures.jsonl')
mkdirSync(ROOT_TMP, { recursive: true })
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
  if (failures === 0) {
    try {
      rmSync(ROOT_TMP, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`[forensics] worlds kept: ${ROOT_TMP}`)
  }
}
process.on('exit', reap)

console.log('============================================================')
console.log(' cap offer LIST + BINDING POOL — the real binary, loopback lanes')
console.log('============================================================')

// ── the PTY drive ───────────────────────────────────────────────────────────
/** A scripted keystroke. `requireAwait` makes the send fire ONLY on its
 *  await (never blind at a deadline — a card that rises late on a busy box
 *  still gets its key); `afterPrevTicks` schedules relative to the previous
 *  send's actual fire tick. The capture ends early once every send is done
 *  and the grid is stable, so a generous `total` costs nothing when fast. */
type Send = { atTick?: number; minTick?: number; afterPrevTicks?: number; requireAwait?: boolean; awaitText?: string; awaitSettleTicks?: number; data: string; mark?: string }
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
type Payload = { grid: Array<Array<{ c: string }>>; sendReceipts?: Array<{ atTick?: number; ts?: number }>; marks?: Mark[]; endReason?: string }
type Capture = { kind: string; method?: string; url?: string; body?: Record<string, unknown>; at: number }

const gridText = (grid: Array<Array<{ c: string }>>): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
const lines = (text: string): string[] => text.split('\n')

function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: base,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    ZAI_API_KEY: 'zai-fixture-key',
    MERCURY_ZAI_API_BASE: `${base}/zai/api/paas/v4`,
    DEEPSEEK_API_KEY: 'sk-deepseek-fixture-key',
    MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
    // The fixture limits seam: armed, inert until a scenario is set.
    MERCURY_MOCK_LIMITS: '1',
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
    MERCURY_DOCTOR_STATE_DIR: path.join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(home, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(home, 'teams'),
    MERCURY_TABULA_DIR: path.join(home, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(home, 'proof-home'),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  delete env.OPENAI_API_KEY
  delete env.MOONSHOT_API_KEY
  delete env.MERCURY_CAP_FAILOVER
  delete env.MERCURY_MOCK_USAGE_PAYLOAD
  return env
}

function readCaptures(): Capture[] {
  return readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
}

function drive(name: string, world: { home: string; cwd: string }, env: NodeJS.ProcessEnv, model: string, sends: Send[], total: number): { payload: Payload | null; wire: Capture[]; status: number | null } {
  const before = readCaptures().length
  const out = path.join(world.home, `grid-${name}.json`)
  const cfg = { argv: ['node', DIST, '--model', model], cwd: world.cwd, sends, stableTicks: 4, total, cols: 110, rows: 34, out }
  const cfgPath = path.join(world.home, `cfg-${name}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(240_000), cwd: world.cwd, env })
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
  return { payload, wire: readCaptures().slice(before), status: res.status }
}
const markGrid = (payload: Payload | null, label: string): string => {
  const mark = payload?.marks?.find(m => m.label === label)
  return mark ? gridText(mark.grid) : ''
}
const receiptTick = (payload: Payload | null, index: number): number => payload?.sendReceipts?.[index]?.atTick ?? -1
const tail = (text: string, n = 14): string => lines(text).slice(-n).join('\n')
/** The card's row line naming a family (the list paints one row per family). */
const rowLine = (grid: string, family: string): string | undefined =>
  lines(grid).find(l => l.includes(` ${family} ⇄ `))

// ── LIST: an OpenAI home, three other families, one at its cap ─────────────
// The Anthropic lane is a SUBSCRIPTION here too: the fixture limits seam
// feeds the subscriber-gated latch, and that latch is what marks the lane
// at its cap (a key-credentialed lane has no window latch to cap).
const listWorld = seedWorld('list', { openaiSubscription: true, claudeSubscription: true, anthropicKeyApproved: false })
const listEnv = {
  ...baseEnv(listWorld.home),
  // The Anthropic lane AT ITS CAP through the usage payload seam: the weekly
  // window at 100% (the resolver reads the usage owner's binding pick as a
  // reached window), the 5h window calm, no per-model pools stated.
  MERCURY_MOCK_USAGE_PAYLOAD: JSON.stringify({
    five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 100, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
  }),
}
// Sends (in order; every gate STRICT — it fires on its await, never blind):
//   [0] ↵ on New Session · [1] /mock-limits clear (the window observed)
//   [2] /usage (the tab's fetch folds the payload) · [3] esc closes the tab
//   [4] the GPT turn (its usage bands arm the offer)
//   [5] the card stands (mark 'list') → ↓     [6] mark 'down1' → ↓
//   [7] mark 'down2' (the at-cap row) → ↵ (inert)
//   [8] mark 'inert' (the card still stands) → ↑
//   [9] mark 'up1' (DeepSeek again) → ↵ (the preview for THAT row)
//   [10] the preview → ↵ (the settlement)    [11] settled → the pickup
//   [12] the no-repaint probe — fires on the offer title if it ever
//        returns, else PROBE_GAP ticks after the pickup (the deadline)
const PROBE_GAP = 60
const list = drive(
  'list',
  listWorld,
  listEnv,
  'gpt-5.6-sol',
  [
    { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 20, data: '/mock-limits clear\r', mark: 'observed' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 6, awaitSettleTicks: 3, data: '/usage\r', mark: 'usage' },
    { afterPrevTicks: 15, data: '\x1b', mark: 'usage-close' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 6, awaitSettleTicks: 3, data: 'hello sol\r' },
    { requireAwait: true, awaitText: OPENAI_OFFER_TITLE, minTick: 12, awaitSettleTicks: 4, data: '\x1b[B', mark: 'list' },
    { requireAwait: true, awaitText: OPENAI_OFFER_TITLE, minTick: 4, awaitSettleTicks: 2, data: '\x1b[B', mark: 'down1' },
    { requireAwait: true, awaitText: OPENAI_OFFER_TITLE, minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'down2' },
    { requireAwait: true, awaitText: OPENAI_OFFER_TITLE, minTick: 4, awaitSettleTicks: 3, data: '\x1b[A', mark: 'inert' },
    { requireAwait: true, awaitText: OPENAI_OFFER_TITLE, minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'up1' },
    { requireAwait: true, awaitText: 'Model switch preview', minTick: 6, awaitSettleTicks: 2, data: '\r', mark: 'preview' },
    { requireAwait: true, awaitText: 'Set model to', minTick: 8, awaitSettleTicks: 2, data: 'pick up from gpt pls\r', mark: 'settled' },
    { afterPrevTicks: PROBE_GAP, awaitText: OPENAI_OFFER_TITLE, data: '', mark: 'probe' },
  ],
  1200,
)
{
  const p = list.payload
  const wire = list.wire
  const finalGrid = p ? gridText(p.grid) : ''
  section('L1 — the offer lists every other signed-in family, the at-cap lane last and marked')
  const listGrid = markGrid(p, 'list')
  check('the offer card stood when the first ↓ was sent', listGrid.includes(OPENAI_OFFER_TITLE), `status=${list.status} endReason=${p?.endReason ?? '?'}\n${tail(listGrid)}`)
  const zaiLine = rowLine(listGrid, 'Z.AI')
  const deepseekLine = rowLine(listGrid, 'DeepSeek')
  const anthropicLine = rowLine(listGrid, 'Anthropic')
  check('three rows: Z.AI, DeepSeek and Anthropic', zaiLine !== undefined && deepseekLine !== undefined && anthropicLine !== undefined, tail(listGrid))
  const order = ['Z.AI', 'DeepSeek', 'Anthropic'].map(f => lines(listGrid).findIndex(l => l.includes(` ${f} ⇄ `)))
  check('the rows keep the sign-in order with the at-cap lane LAST', order[0] < order[1] && order[1] < order[2], JSON.stringify(order))
  check(`each row names the exact landing row (${ZAI_ROW} · ${DEEPSEEK_ROW} · ${FABLE_51})`, (zaiLine ?? '').includes(ZAI_ROW) && (deepseekLine ?? '').includes(DEEPSEEK_ROW) && (anthropicLine ?? '').includes(FABLE_51))
  check("the key lanes report no usage ('no usage read'); the capped lane is marked at its cap", (zaiLine ?? '').includes('no usage read') && (deepseekLine ?? '').includes('no usage read') && (anthropicLine ?? '').includes('at its cap'))
  check('the default highlight is the first row (Z.AI), the subtitle its landing row', (zaiLine ?? '').includes('▸') && !(deepseekLine ?? '').includes('▸') && listGrid.includes(`⇄ ${ZAI_ROW}`))
  check('the guide says ↑↓ choose beside the one true enter line', listGrid.includes('↑↓ choose') && listGrid.includes('enter opens the transition preview'))

  section('L2 — ↓ moves the highlight on the real card')
  const down1 = markGrid(p, 'down1')
  check('after one ↓ the cursor sits on DeepSeek and the subtitle names its row', (rowLine(down1, 'DeepSeek') ?? '').includes('▸') && !(rowLine(down1, 'Z.AI') ?? '').includes('▸') && down1.includes(`⇄ ${DEEPSEEK_ROW}`), tail(down1))

  section('L3 — the at-cap row: enter never advertised, ↵ inert')
  const down2 = markGrid(p, 'down2')
  check('after two ↓ the cursor sits on the at-cap Anthropic row', (rowLine(down2, 'Anthropic') ?? '').includes('▸'), tail(down2))
  check('the guide there never names enter; the lane is said not usable', !down2.includes('enter opens') && down2.includes('dismisses') && down2.includes('not usable right now'))
  const inert = markGrid(p, 'inert')
  check('↵ on the at-cap row is INERT — the card still stands, no preview opened', inert.includes(OPENAI_OFFER_TITLE) && !inert.includes('Model switch preview'), tail(inert))

  section('L4 — ↑ to a usable row; ↵ opens the preview for THAT row and settles on it')
  const up1 = markGrid(p, 'up1')
  check('after ↑ the cursor is back on DeepSeek', (rowLine(up1, 'DeepSeek') ?? '').includes('▸'), tail(up1))
  const preview = markGrid(p, 'preview')
  check('↵ opened the transition preview for the highlighted row (DeepSeek), not the first', preview.includes('Model switch preview') && (preview.includes('DeepSeek') || preview.includes(DEEPSEEK_ROW)) && !preview.includes(ZAI_ROW), tail(preview))
  const settledTick = receiptTick(p, 11)
  check('the settlement receipt painted (the pickup send fired on its await)', settledTick > 0, `pickup send at tick ${settledTick}; endReason=${p?.endReason ?? '?'}`)
  const settled = markGrid(p, 'settled')
  check('the receipt names the chosen row', settled.includes('Set model to') && (settled.includes('DeepSeek') || settled.includes(DEEPSEEK_ROW)), tail(settled, 8))
  const deepseekCalls = wire.filter(c => c.kind === 'deepseek')
  const main = deepseekCalls.find(c => JSON.stringify(c.body ?? {}).includes('pick up from gpt pls'))
  check("the next turn DISPATCHED to the chosen lane's wire (DeepSeek), carrying the ask", main !== undefined, `deepseek=${deepseekCalls.length} kinds=${wire.map(c => c.kind).join(',')}`)
  check(`the switched request targets the exact chosen row (${DEEPSEEK_ROW})`, String(main?.body?.model ?? '').startsWith(DEEPSEEK_ROW), String(main?.body?.model))
  check('no MAIN turn reached the Z.AI or Anthropic wires (a utility probe is not a turn)', !wire.some(c => (c.kind === 'zai' || c.kind === 'anthropic') && JSON.stringify(c.body ?? {}).includes('pick up from gpt pls')))
  check('the switched reply painted', finalGrid.includes(DEEPSEEK_REPLY) || markGrid(p, 'probe').includes(DEEPSEEK_REPLY), tail(finalGrid, 10))

  section('L5 — the offer never re-paints after the settlement')
  const probeTick = receiptTick(p, 12)
  check('the no-repaint probe fired on its DEADLINE (the card never returned)', settledTick > 0 && probeTick >= settledTick + PROBE_GAP - 1, `probe at tick ${probeTick} (pickup at ${settledTick}, gap ${PROBE_GAP})`)
  check('no offer card on the final screen', !finalGrid.includes(OPENAI_OFFER_TITLE))
}

// ── POOL: an Anthropic-subscription home on a Fable seat ───────────────────
const poolWorld = seedWorld('pool', { openaiSubscription: false, claudeSubscription: true, anthropicKeyApproved: false })
const poolResetIso = new Date(Date.now() + (22 * 3600 + 51 * 60) * 1000).toISOString()
const poolEnv = {
  ...baseEnv(poolWorld.home),
  // The fixture usage response: 5h 36% · week 44% · the FABLE pool at 87%.
  MERCURY_MOCK_USAGE_PAYLOAD: JSON.stringify({
    five_hour: { utilization: 36, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 44, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
    seven_day_fable: { utilization: 87, resets_at: poolResetIso },
  }),
}
// Sends: [0] ↵ New Session · [1] /mock-limits clear (the window observed,
// status allowed — BEFORE the pools land, so the card cannot rise under the
// keystrokes) · [2] /usage (the tab's fetch folds the fixture response into
// the usage record) · [3] esc closes the tab (deadline-fired) · [4] the card
// names the pool → ↵ · [5] settled → the pickup · [6] the probe
const pool = drive(
  'pool',
  poolWorld,
  poolEnv,
  FABLE_51,
  [
    { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 20, data: '/mock-limits clear\r', mark: 'observed' },
    { requireAwait: true, awaitText: '? for shortcuts', minTick: 6, awaitSettleTicks: 3, data: '/usage\r', mark: 'usage' },
    { afterPrevTicks: 15, data: '\x1b', mark: 'usage-close' },
    { requireAwait: true, awaitText: ANTHROPIC_OFFER_TITLE, minTick: 6, awaitSettleTicks: 4, data: '\r', mark: 'pool-offer' },
    { requireAwait: true, awaitText: 'Set model to', minTick: 6, awaitSettleTicks: 2, data: 'pick up from fable pls\r', mark: 'settled' },
    { afterPrevTicks: PROBE_GAP, awaitText: ANTHROPIC_OFFER_TITLE, data: '', mark: 'probe' },
  ],
  900,
)
{
  const p = pool.payload
  const wire = pool.wire
  const finalGrid = p ? gridText(p.grid) : ''
  section("P1 — the offer fires on the BINDING window (the Fable pool) and names it in the usage owner's words")
  const offerTick = receiptTick(p, 4)
  check('the offer fired from the fixture usage response alone (no turn ran; the send fired on its await)', offerTick > 0, `offer send at tick ${offerTick}; status=${pool.status}; endReason=${p?.endReason ?? '?'}\n${tail(markGrid(p, 'observed'))}`)
  const offer = markGrid(p, 'pool-offer')
  check('the card stood when enter was sent', offer.includes(ANTHROPIC_OFFER_TITLE), tail(offer))
  check("the card names the Fable pool in the strip's words — 'approaching the Anthropic Fable limit' — never 'weekly Fable'", offer.includes('approaching the Anthropic Fable limit') && !offer.includes('weekly Fable'), tail(offer))
  check('the card lists the two key lanes with the Z.AI row highlighted first', (rowLine(offer, 'Z.AI') ?? '').includes('▸') && rowLine(offer, 'DeepSeek') !== undefined && offer.includes(`⇄ ${ZAI_ROW}`), tail(offer))

  section("P2 — ↵ settles on the highlighted row; the next turn dispatches to that lane's wire")
  const settled = markGrid(p, 'settled')
  check('the settlement receipt painted (a plain history needs no preview)', settled.includes('Set model to'), tail(settled, 8))
  const zaiCalls = wire.filter(c => c.kind === 'zai')
  const main = zaiCalls.find(c => JSON.stringify(c.body ?? {}).includes('pick up from fable pls'))
  check("the next turn DISPATCHED to the chosen lane's wire (Z.AI)", main !== undefined, `zai=${zaiCalls.length} kinds=${wire.map(c => c.kind).join(',')}`)
  check(`the switched request targets the exact chosen row (${ZAI_ROW})`, String(main?.body?.model ?? '').startsWith(ZAI_ROW), String(main?.body?.model))
  check('no MAIN turn reached the Anthropic wire (the seat left before any turn; a utility probe is not a turn)', !wire.some(c => c.kind === 'anthropic' && JSON.stringify(c.body ?? {}).includes('pick up from fable pls')))
  check('the switched reply painted', finalGrid.includes(ZAI_REPLY) || markGrid(p, 'probe').includes(ZAI_REPLY), tail(finalGrid, 10))
  const settledTick = receiptTick(p, 5)
  const probeTick = receiptTick(p, 6)
  check('the offer never re-paints after the settlement (the probe fired on its deadline)', settledTick > 0 && probeTick >= settledTick + PROBE_GAP - 1, `probe at tick ${probeTick} (pickup at ${settledTick}, gap ${PROBE_GAP})`)
  // The way home is read FOR the seat the session ran on: the Fable pool
  // still binds, so no false "window reset — return?" card rises after the
  // switch (the note carries the seat's own model, never the screen's).
  check('no false way-home card after the switch (the home window is read for the seat\'s own model)', !finalGrid.includes('window reset') && !markGrid(p, 'probe').includes('window reset'), tail(finalGrid, 10))
}

if (failures > 0) {
  for (const world of ['list', 'pool']) {
    try {
      const debugDir = path.join(ROOT_TMP, world, 'debug')
      if (!existsSync(debugDir)) continue
      const latest = readdirSync(debugDir).filter(f => f.endsWith('.txt')).sort().at(-1)
      if (!latest) continue
      const t = readFileSync(path.join(debugDir, latest), 'utf8').split('\n').filter(l => !l.includes('High write ratio')).slice(-20).join('\n')
      console.log(`\n[forensics] ${world} debug log tail:\n${t}`)
    } catch {
      /* forensics best-effort */
    }
  }
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
