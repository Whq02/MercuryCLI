#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-broadcast-look.ts — THE LOOK, one capture at
//  the fold (vshot on the BUILT bundle; the broadcast look
//  pin). The whole mechanism in one journey on the reference board:
//
//   L1  marking (140×40): space on the selected row wears the check; a
//       second marked row flips the live composer's placeholder to the
//       counted broadcast face — "message 2 sessions · ↵↵ sends to all
//       marked".
//   L2  the count follows the marks: a third mark (a QUEUED row) reads
//       "message 3 sessions".
//   L3  the arm names the count: with words in the box the first ↵ arms —
//       "broadcast · sends to 3 sessions · ↵ again sends · esc cancels".
//   L4  the honest partial send: ↵↵ fans through the one steering door —
//       the summary reads "sent to 2 of 3 · 1 skipped", the selected
//       queued row paints its typed skip reason, the marks survive the
//       send (esc clears them), and the composer is empty again.
//
//  Hermetic: scratch config home; the board renders the fixture seam
//  (MERCURY_CONCOURSE_FIXTURE); the API base is a closed port — no wire.
//  The fixture's QUEUED rows are re-minted with the live builder's own
//  `dispatch:` prefix (concourseSnapshot mints queued reservations exactly
//  so) — the landed gate keys the queued refusal on that prefix.
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
const OUT_DIR = process.env.BROADCAST_CAPTURE_DIR ?? join(tmpdir(), `broadcast-look-${process.pid}`)
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
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
  /** The strict gate (vshot.py): the await is the ONLY trigger — without it
   * a gated send is due at tick 1 and fires blind (the
   *  sweep in scripts/ui/prove-vshot-send-hygiene.ts). */
  requireAwait?: boolean
}

// ── the scratch home ────────────────────────────────────────────────────────
const scratch = join(tmpdir(), `broadcast-look-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])

// ── the fixture: the reference board with NO needs-you rows (deterministic
//    Tab ring: coordinator · list · live) and the QUEUED rows re-minted
//    with the live builder's own dispatch: prefix, so the gate's queued
//    refusal is the same truth the live estate speaks ──────────────────────
const fixture = referenceFixtureSnapshot() as {
  needsYou: unknown[]
  counts: { needsYou: number }
  groups: Array<{ id: string; rows: Array<{ sessionId: string }> }>
}
fixture.needsYou = []
fixture.counts.needsYou = 0
for (const g of fixture.groups) {
  if (g.id !== 'queued') continue
  for (const r of g.rows) r.sessionId = `dispatch:${r.sessionId}`
}
const fixturePath = join(scratch, 'broadcast-look-fixture.json')
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

// ── the one capture (140×40): mark · mark · mark queued · speak · ↵ · ↵↵ ───
//  Board flat order: s-audit (ready) · s-oauth · s-parser · s-resize
//  (working) · dispatch:s-trace · dispatch:s-launchdoc (queued). Boot lands
//  with the coordinator holding the keys; ONE tab reaches the list.
{
  const DOWN = String.fromCharCode(27) + '[B'
  // THE RIG'S MARK FACT (scripts/ui/vshot.py; inventory rows 425/426): a
  // mark snapshots the grid BEFORE its own send's bytes are written — so a
  // post-key frame rides a FOLLOW-UP empty send, gated on the text the key
  // should paint where one exists (the first real run of this pin read every
  // mark one key early).
  const sends: Send[] = [
    { data: '\t', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 2 },
    { data: ' ', afterPrevTicks: 2 },
    { data: DOWN, afterPrevTicks: 1 },
    { data: ' ', afterPrevTicks: 1 },
    { data: '', awaitText: 'message 2 sessions', requireAwait: true, awaitSettleTicks: 2, mark: 'two-marked' },
    { data: DOWN + DOWN + DOWN, afterPrevTicks: 2 },
    { data: ' ', afterPrevTicks: 1 },
    { data: '', awaitText: 'message 3 sessions', requireAwait: true, awaitSettleTicks: 2, mark: 'three-marked' },
    { data: '\t', afterPrevTicks: 1 },
    { data: 'sync with the tracker branch', afterPrevTicks: 1 },
    { data: '\r', afterPrevTicks: 2 },
    { data: '', awaitText: 'broadcast · sends to', requireAwait: true, awaitSettleTicks: 2, mark: 'armed' },
    { data: '\r', afterPrevTicks: 2 },
    { data: '', awaitText: 'sent to', requireAwait: true, awaitSettleTicks: 3, mark: 'sent' },
  ]
  const out = join(OUT_DIR, 'broadcast-140x40.json')
  const cfgPath = join(scratch, 'vshot-broadcast.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 40, cols: 140, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) {
    console.error(`✗ vshot (140×40) failed: ${(res.stderr ?? '').slice(-600)}`)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const marks = new Map<string, string[]>()
  for (const m of payload.marks ?? []) {
    marks.set(m.label, linesOf(m))
    writeFileSync(join(OUT_DIR, `mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  const mk = (label: string): string[] => marks.get(label) ?? []
  const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))

  console.log('L1 — marking: the check on the row, the counted placeholder at two marks')
  check('the first marked row wears the check beside its title', mk('two-marked').some(l => l.includes('✓') && l.includes('Audit billing receipts')))
  check('the second marked row wears it too', mk('two-marked').some(l => l.includes('✓') && l.includes('Fix OAuth callback')))
  check(
    'the live composer speaks the broadcast face (the exact spelling)',
    has(mk('two-marked'), 'message 2 sessions · ↵↵ sends to all marked'),
  )
  console.log('L2 — the count follows the marks')
  check('a third mark (the queued reservation) counts to 3', has(mk('three-marked'), 'message 3 sessions'))
  check('the queued row wears the check', mk('three-marked').some(l => l.includes('✓') && l.includes('Trace reconnect race')))
  console.log('L3 — the arm names the count')
  check(
    'the first ↵ arms — the context line names the count and the way out',
    has(mk('armed'), 'broadcast · sends to 3 sessions · ↵ again sends · esc cancels'),
  )
  console.log('L4 — the honest partial send')
  check('the summary is the ruled arithmetic', has(mk('sent'), 'sent to 2 of 3 · 1 skipped'))
  check(
    'the selected queued row paints its typed skip reason (the receipt on the row)',
    has(mk('sent'), 'skipped — queued'),
  )
  check('the marks survive the send (esc is the clear gesture)', mk('sent').some(l => l.includes('✓') && l.includes('Fix OAuth callback')))
  check('the composer is empty again — the broadcast face placeholder returned', has(mk('sent'), 'message 3 sessions · ↵↵ sends to all marked'))
  check('POISON: the spoken words left the box (one message, spoken once)', !has(mk('sent'), 'sync with the tracker branch'))
}

console.log(failures === 0 ? '\nbroadcast look: GREEN' : `\nbroadcast look: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
