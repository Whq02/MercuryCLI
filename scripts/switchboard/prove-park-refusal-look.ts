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
  console.error('build the product before the capture')
  process.exit(1)
}
const OUT_DIR = process.env.PARK_REFUSAL_CAPTURE_DIR ?? join(tmpdir(), `park-refusal-look-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

const now = Date.now()
const record = {
  sessionId: 's-oauth',
  workspaceId: REPO,
  spawnedAt: now - 7 * 60_000,
  lastDeliveryAt: now - 6 * 60_000,
  lastTurnSettledAt: now - 5 * 60_000,
  pid: process.pid,
}
const refusedLabel = snapshot.concourseNowLabel({ ...record, parkRefused: { reason: 'a turn is in flight', at: now, by: 'daemon: memory' } }, { alive: true, needsYou: false }, now)
const parkingLabel = snapshot.concourseNowLabel({ ...record, parkIntent: { token: 'tok-look', by: 'operator:close', at: now, pid: process.pid } }, { alive: true, needsYou: false }, now)
check("the snapshot's NOW cell for a refused park is 'park refused — <reason>'", refusedLabel === 'park refused — a turn is in flight', String(refusedLabel))
check("the snapshot's NOW cell for a park in flight is 'parking — <who asked>'", parkingLabel === 'parking — operator:close', String(parkingLabel))
check('a parked row keeps its own cell (the refusal never outranks parked)', snapshot.concourseNowLabel({ ...record, parkedAt: now - 60_000, parkRefused: { reason: 'stale', at: now, by: 'x' } }, { alive: false, needsYou: false }, now) === 'parked · 01m')

const scratch = join(tmpdir(), `park-refusal-look-${process.pid}-home`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])
{
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 4 }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

const fixture = referenceFixtureSnapshot()
for (const g of fixture.groups) {
  for (const r of g.rows) {
    if (r.sessionId === 's-oauth') r.nowLabel = refusedLabel ?? ''
    if (r.sessionId === 's-parser') r.nowLabel = parkingLabel ?? ''
  }
  if (g.id === 'ready-to-review') g.rows = []
}
fixture.counts.live = 3
const fixturePath = join(scratch, 'park-refusal-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

function capture(cols: number, rows: number): string[] {
  const out = join(OUT_DIR, `park-refusal-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `vshot-${cols}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends: [{ data: '', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 3, mark: 'board' }], total: 60, cols, rows, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(180_000),
    env: {
      ...(process.env as Record<string, string>),
      MERCURY_CONFIG_DIR: scratch,
      MERCURY_HOME: '',
      MERCURY_SPLASH: 'off',
      MERCURY_CONCOURSE: 'always',
      MERCURY_CONCOURSE_FIXTURE: fixturePath,
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREW_DIR: join(scratch, 'crew'),
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_PARTY: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  if (res.status !== 0) {
    console.error(`vshot failed at ${cols} columns: ${(res.stderr ?? '').slice(-600)}`)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const mark = payload.marks?.find(m => m.label === 'board')
  const lines = mark ? linesOf(mark) : linesOf(payload)
  writeFileSync(join(OUT_DIR, `park-refusal-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  return lines
}

for (const [cols, rows] of [[120, 40], [80, 30]] as const) {
  console.log(`the board at ${cols}x${rows}`)
  const lines = capture(cols, rows)
  const has = (needle: string): boolean => lines.some(l => l.includes(needle))
  const oauth = lines.find(l => l.includes('Fix OAuth')) ?? ''
  const parser = lines.find(l => l.includes('Refactor pars')) ?? ''
  check(`the refused row's NOW cell leads with 'park refused' inside the column at ${cols} columns`, /park refused — a\S*/.test(oauth), oauth)
  check(`the parking row's NOW cell leads with 'parking' and the asker at ${cols} columns`, /parking — operator\S*/.test(parser), parser)
  check(`both rows stay in the live group under WORKING (never parked, never needs-you) at ${cols} columns`, !oauth.includes('parked ·') && !parser.includes('parked ·') && !oauth.includes('needs you') && !parser.includes('needs you') && /[◒◐◓◑]/.test(oauth) && /[◒◐◓◑]/.test(parser), `${oauth} | ${parser}`)
}

console.log(failures === 0 ? `\npark refusal look: GREEN (frames under ${OUT_DIR})` : `\npark refusal look: ${failures} RED (frames under ${OUT_DIR})`)
process.exit(failures === 0 ? 0 : 1)
