#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-exit-everywhere-look.ts — THE LOOK, one capture
//  at the fold (vshot on the BUILT bundle; ledger L22's look pin): the exit
//  chord's notice on the BOARD at 120×40 — one ctrl+c on the concourse paints
//  "press ctrl+c twice to close Mercury" at the BOTTOM-LEFT of the screen in
//  the REPL's own words (the same component the REPL footer paints), over
//  the board's help rail, the board itself standing whole; the process is
//  still alive (one press never exits). The mark's text lands in the
//  capture dir for the fold's eyes.
//
//  Hermetic: scratch config home; the board renders the fixture seam
//  (MERCURY_CONCOURSE_FIXTURE); the API base is a closed port — no wire.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const OUT_DIR = process.env.EXIT_LOOK_CAPTURE_DIR ?? join(tmpdir(), `exit-everywhere-look-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { resolveCaptureDriver, captureEngineEntry } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') {
  console.error(`✗ no capture driver: ${driver.reason} — ${driver.remedy}`)
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

const NOTICE = 'press ctrl+c twice to close Mercury'
const NOTICE_ROW = `  ${NOTICE}`

// ── the scratch home + the reference board (no needs-you rows) ─────────────
const scratch = join(tmpdir(), `exit-everywhere-look-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])
const fixture = referenceFixtureSnapshot()
fixture.needsYou = []
fixture.counts.needsYou = 0
const fixturePath = join(scratch, 'exit-look-fixture.json')
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

// ONE press on the board, then the settled notice frame (the rig snapshots
// a mark BEFORE writing its send's bytes — the empty follow-up send, gated
// on the notice itself, IS the frame); the capture ends on readyText.
const sends = [
  { data: '\x03', requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
  { data: '', requireAwait: true, awaitText: NOTICE, awaitSettleTicks: 2, mark: 'notice' },
]
const out = join(OUT_DIR, 'exit-notice-board-120x40.json')
const cfgPath = join(scratch, 'vshot-exit-look.json')
writeFileSync(
  cfgPath,
  JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 150, cols: 120, rows: 40, out, readyText: NOTICE, readySettleTicks: 3 }),
)
const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { encoding: 'utf8', timeout: 300_000, env })
if (res.status !== 0) {
  console.error(`✗ vshot (120×40) failed: ${(res.stderr ?? '').slice(-800)}`)
  process.exit(1)
}
const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { endReason: string; marks?: ({ label: string } & Grid)[] }
const mark = payload.marks?.find(m => m.label === 'notice')
const lines = mark !== undefined ? linesOf(mark) : []
writeFileSync(join(OUT_DIR, 'mark-notice.txt'), lines.join('\n') + '\n')
const has = (needle: string): boolean => lines.some(l => l.includes(needle))

console.log('THE LOOK — the exit notice on the board at 120×40')
check('the notice frame was captured', mark !== undefined)
check("the notice sits at the BOTTOM-LEFT: the last row starts with it, in the REPL's own words",
  lines.length === 40 && lines[39]!.startsWith(NOTICE_ROW), JSON.stringify(lines[39] ?? ''))
check('…and nowhere else on the frame (one owner, one row)', lines.slice(0, 39).every(l => !l.includes(NOTICE)))
check('the board stands whole beneath it (SESSIONS · COORDINATOR)', has('SESSIONS') && has('COORDINATOR'))
check('one press never exits — the process is alive at the capture (endReason not eof)', payload.endReason !== 'eof', payload.endReason)
console.log(`  [info] the mark's text: ${join(OUT_DIR, 'mark-notice.txt')}`)

console.log(failures === 0 ? '\nexit-everywhere look: GREEN' : `\nexit-everywhere look: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
