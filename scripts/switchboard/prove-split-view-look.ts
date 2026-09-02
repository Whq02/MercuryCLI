#!/usr/bin/env bun
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

const scratch = join(tmpdir(), `split-view-look-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])

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

{
  const sends: Send[] = [
    { data: '\t', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 2 },
    { data: 's', afterPrevTicks: 2 },
    { data: '', awaitText: 'FOCUSED CHAT', requireAwait: true, awaitSettleTicks: 2, mark: 'split-on' },
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
  check("the board pane's header sheds at the pane's width — lockup and crumb never collide", !has(mk('split-on'), 'CONCOURSEBOOT') && has(mk('split-on'), 'FOCUSED CHAT ›'))
  console.log('L2 — pane focus at a glance')
  check('the chat pane names the way back while it owns the keys', has(mk('chat-focused'), 'tab board · s full board'))
  console.log('L3 — the way back')
  check('s from the chat pane returns the full board (no chat pane header remains)', !has(mk('split-off'), 'tab chat pane') && !has(mk('split-off'), 'tab board · s full board'))
  check('the board still stands whole', has(mk('split-off'), 'SESSIONS'))
}

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
  check('nothing split — no chat pane column appeared', !has('tab chat pane') && !has('tab board · s full board'))
}

console.log(failures === 0 ? '\nsplit-view look: GREEN' : `\nsplit-view look: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
