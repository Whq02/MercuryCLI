#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-manager-self-managed-drive.ts — MANAGER MODE in
//  the SELF-MANAGED world (ledger L22), on the built bundle (vshot on the
//  fixture board, whose coordinator is 'rules-only' — the default launcher
//  world where the operator's shift+tab leaked to the Tab ring).
//
//   L1  shift+tab ON the coordinator composer ARMS the mode: the composer
//       wears the ∷ band ("manager mode on") and its rest hint is the
//       manager's — POISON: the ring's backward step (the toggle never
//       fires, no band ever paints, the live composer takes the keys).
//   L2  the honest first line: this scratch home has no coordinator model
//       chosen, so arming says so at once and names the pick.
//   L3  a goal sent with no model is NEVER a direct launch: the note names
//       the pick, the draft STAYS in the composer, no launch receipt, no
//       thinking row.
//   L4  shift+tab again disarms (the toggle cycles).
//
//  Hermetic: scratch config home; the board renders the fixture seam
//  (MERCURY_CONCOURSE_FIXTURE); the API base is a closed port — no wire.
//  Sends are STRICTLY gated on their needles (requireAwait) and every
//  post-send frame is a follow-up mark (the rig snapshots a mark BEFORE
//  writing its own send's bytes).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const OUT_DIR = process.env.MANAGER_SELF_CAPTURE_DIR ?? join(tmpdir(), `manager-self-managed-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

interface Send {
  data: string
  awaitText?: string
  awaitSettleTicks?: number
  requireAwait?: boolean
  afterPrevTicks?: number
  mark?: string
}

const SHIFT_TAB = '\x1b[Z'
const GOAL = 'ship the widget zq'
// The board's two-pane cut narrowed the composer pane: long rows paint
// middle/leading-truncated ('manager mode needs…tor chip) picks one',
// '…hip the widget zq▌'), so whole-phrase needles read a lawful frame as
// red. Each pin keeps the DISTINCTIVE visible pieces around the ellipsis.
const HONEST_HEAD = 'manager mode needs'
const HONEST_TAIL = 'picks one'
const GOAL_TAIL = 'the widget zq'

// ── the scratch home: NO coordinator model chosen (the honest-line world) ──
const scratch = join(tmpdir(), `manager-self-managed-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])

// The reference board with no needs-you rows and the coordinator RULES-ONLY
// (the self-managed world): the composer is the boot's focused region.
const fixture = referenceFixtureSnapshot()
fixture.needsYou = []
fixture.counts.needsYou = 0
fixture.coordinator = { mode: 'rules-only' }
const fixturePath = join(scratch, 'manager-self-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

const env = {
  ...(process.env as Record<string, string>),
  MERCURY_CONFIG_DIR: scratch,
  MERCURY_HOME: '',
  MERCURY_CONCOURSE: 'always',
  MERCURY_CONCOURSE_FIXTURE: fixturePath,
  MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
  MERCURY_CREW_DIR: join(scratch, 'crew'),
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_PARTY: '0',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
}

const sends: Send[] = [
  // The board is up with the coordinator composer holding the keys.
  { data: SHIFT_TAB, requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
  // The armed frame — the band painted; the arming note is an async read,
  // so a few settle ticks ride the needle.
  { data: '', requireAwait: true, awaitText: 'manager mode on', awaitSettleTicks: 6, mark: 'armed' },
  { data: GOAL, afterPrevTicks: 1 },
  { data: '\r', afterPrevTicks: 4 },
  // 2 s after ↵: the pre-send model read answered, the note painted.
  { data: '', afterPrevTicks: 10, mark: 'sent' },
  { data: SHIFT_TAB, afterPrevTicks: 1 },
  { data: '', afterPrevTicks: 5, mark: 'disarmed' },
]
const out = join(OUT_DIR, 'manager-self-managed-120x40.json')
const cfgPath = join(scratch, 'vshot-manager-self.json')
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 150, cols: 120, rows: 40, out }))
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(300_000), env })
if (res.status !== 0) {
  console.error(`✗ vshot (120×40) failed: ${(res.stderr ?? '').slice(-800)}`)
  process.exit(1)
}
const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
const marks = new Map<string, string[]>()
for (const m of payload.marks ?? []) {
  marks.set(m.label, linesOf(m))
  writeFileSync(join(OUT_DIR, `mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
}
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const mk = (label: string): string[] => marks.get(label) ?? []

console.log('L1 — shift+tab on the coordinator composer arms the mode in the self-managed world')
check('the composer wears the ∷ band (manager mode on)', has(mk('armed'), 'manager mode on'))
check("the rest hint is the manager's (one goal, one shot) — the composer kept the keys (poison: the ring step)", has(mk('armed'), 'one goal, one shot'))
check('the board still stands (SESSIONS on the frame)', has(mk('armed'), 'SESSIONS'))

console.log('L2 — the honest first line with no model chosen')
check('arming names the pick at once', has(mk('armed'), HONEST_HEAD) && has(mk('armed'), HONEST_TAIL))

console.log('L3 — a goal with no model is never a direct launch')
check('the note names the pick after ↵', has(mk('sent'), HONEST_HEAD) && has(mk('sent'), HONEST_TAIL))
check('the draft STAYS in the composer', has(mk('sent'), GOAL_TAIL))
check('no launch receipt (poison: the direct-launch path)', !has(mk('sent'), 'starting a session') && !has(mk('sent'), 'the daemon that hosts'))

console.log('L4 — the toggle cycles')
check('shift+tab again disarms the mode', !has(mk('disarmed'), 'manager mode on'))

console.log(failures === 0 ? '\nmanager self-managed drive: GREEN' : `\nmanager self-managed drive: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
