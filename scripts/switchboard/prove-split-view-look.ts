#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-split-view-look.ts — THE LOOK, one capture at
//  the fold (vshot on the BUILT bundle; the split-view look pin).
//
//   L1  the toggle (140×40): `s` from the list splits the frame — the board
//       stands narrowed at the left, the divider rule runs, the chat pane
//       leads with FOCUSED CHAT and (no focused session in the fixture
//       world) paints the board's own "↵ new session · <project>" grammar
//       and nothing else.
//   L2  pane focus at a glance: Tab walks the extended ring onto the chat
//       pane — its header brightens and names the way back
//       ('tab board · s full board').
//   L3  the way back: `s` from the chat pane returns the full board — no
//       FOCUSED CHAT column remains.
//   L4  the honest refusal (100×30): `s` on a frame under the two-minimum
//       threshold answers the one width line and the board never splits.
//
//  Hermetic: scratch config home; the board renders the fixture seam
//  (MERCURY_CONCOURSE_FIXTURE); the API base is a closed port — no wire.
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
const OUT_DIR = process.env.SPLITVIEW_CAPTURE_DIR ?? join(tmpdir(), `split-view-look-${process.pid}`)
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
  requireAwait?: boolean
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
// THE RIG'S TWO FACTS (the vshot pre-key-frame class, inventory rows
// 425/426): a `mark` snapshots the grid BEFORE its own send's bytes are
// written, so a post-key frame rides a FOLLOW-UP empty send gated on the
// text the key should paint; and an `awaitText` send without `requireAwait`
// is due at tick 1 and fires BLIND — every gated send here is strict.

// ── the scratch home ────────────────────────────────────────────────────────
const scratch = join(tmpdir(), `split-view-look-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])

// ── the fixture: the reference board with NO needs-you rows, so the Tab
//    ring is deterministic ([coordinator, list, live, chat] — the chat pane
//    is the ring's LAST stop, two tabs from the list) ──────────────────────
const fixture = referenceFixtureSnapshot()
fixture.needsYou = []
fixture.counts.needsYou = 0
const fixturePath = join(scratch, 'split-view-look-fixture.json')
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

// ── capture 1 (140×40): toggle on → tab to the chat pane → toggle off ──────
//  boot lands on the board with the composer holding the keys; ONE tab
//  reaches the list (the letter-verb region) before `s`.
{
  const sends: Send[] = [
    { data: '\t', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 2 },
    { data: 's', afterPrevTicks: 2 },
    { data: '', awaitText: 'FOCUSED CHAT', requireAwait: true, awaitSettleTicks: 2, mark: 'split-on' },
    // The landed ring from the list: live → chat (two tabs; the coordinator
    // is the ring's first stop, the chat pane its LAST).
    { data: '\t\t', afterPrevTicks: 2 },
    { data: '', awaitText: 'tab board · s full board', requireAwait: true, awaitSettleTicks: 2, mark: 'chat-focused' },
    { data: 's', afterPrevTicks: 2 },
    { data: '', afterPrevTicks: 4, mark: 'split-off' },
  ]
  const out = join(OUT_DIR, 'split-view-140x40.json')
  const cfgPath = join(scratch, 'vshot-split.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 30, cols: 140, rows: 40, out }))
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
  const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
  const mk = (label: string): string[] => marks.get(label) ?? []

  console.log('L1 — the split frame stands')
  check('the chat pane leads with FOCUSED CHAT', has(mk('split-on'), 'FOCUSED CHAT'))
  check("no focused session ⇒ the board's own New Session grammar", has(mk('split-on'), '↵ new session'))
  check('the board stands beside it (SESSIONS on the same frame)', has(mk('split-on'), 'SESSIONS'))
  check('the divider rule runs between the panes', has(mk('split-on'), '│'))
  // The header measures the PANE it paints in (ConcourseHeader's columns
  // prop): at the 80-column board pane the full breadcrumb sheds to the
  // compact crumb — the lockup never runs into it ("CONCOURSEBOOT › …" was
  // the terminal-width read on the first real run of this pin).
  check("the board pane's header sheds at the pane's width — lockup and crumb never collide", !has(mk('split-on'), 'CONCOURSEBOOT') && has(mk('split-on'), 'FOCUSED CHAT ›'))
  console.log('L2 — pane focus at a glance')
  check('the chat pane names the way back while it owns the keys', has(mk('chat-focused'), 'tab board · s full board'))
  console.log('L3 — the way back')
  // The breadcrumb carries FOCUSED CHAT on every full board ≥110 cols — the
  // split's own tell is the chat PANE's header words, gone with the pane.
  check('s from the chat pane returns the full board (no chat pane header remains)', !has(mk('split-off'), 'tab chat pane') && !has(mk('split-off'), 'tab board · s full board'))
  check('the board still stands whole', has(mk('split-off'), 'SESSIONS'))
}

// ── capture 2 (100×30): the honest refusal under the threshold ─────────────
{
  const sends: Send[] = [
    { data: '\t', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 2 },
    { data: 's', afterPrevTicks: 2 },
    { data: '', awaitText: 'split needs 121 columns', requireAwait: true, awaitSettleTicks: 1, mark: 'too-narrow' },
  ]
  const out = join(OUT_DIR, 'split-view-100x30.json')
  const cfgPath = join(scratch, 'vshot-narrow.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 20, cols: 100, rows: 30, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) {
    console.error(`✗ vshot (100×30) failed: ${(res.stderr ?? '').slice(-600)}`)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = payload.marks?.length ? linesOf(payload.marks[payload.marks.length - 1]! as Grid) : linesOf(payload)
  writeFileSync(join(OUT_DIR, 'mark-too-narrow.txt'), lines.join('\n') + '\n')
  const has = (needle: string): boolean => lines.some(l => l.includes(needle))
  console.log('L4 — the honest refusal under the threshold')
  check('the one width line names the needed columns', has('split needs 121 columns'))
  // The compact crumb reads "FOCUSED CHAT ›" on every board under 110
  // columns — the pane's own header words are the split's tell.
  check('nothing split — no chat pane column appeared', !has('tab chat pane') && !has('tab board · s full board'))
}

console.log(failures === 0 ? '\nsplit-view look: GREEN' : `\nsplit-view look: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
