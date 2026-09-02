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
const OUT_DIR = process.env.BOARDCTL_CAPTURE_DIR ?? join(tmpdir(), `boardctl-look-${process.pid}`)
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
const ESC = '\x1b'
const DOWN = `${ESC}[B`

interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  awaitStableTicks?: number
  mark?: string
  requireAwait?: boolean
}

const scratch = join(tmpdir(), `boardctl-look-${process.pid}-home`)
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
fixture.counts.live = 4
for (const g of fixture.groups) {
  if (g.id !== 'queued') continue
  g.rows = g.rows.filter(r => r.sessionId !== 's-launchdoc')
}
fixture.groups.push({
  id: 'parked',
  label: 'PARKED',
  rows: [
    {
      sessionId: 's-old',
      title: 'Yesterday: fix the flaky resize test',
      state: 'parked',
      projectLabel: 'Moodle',
      ownerLabel: 'Mercury',
      ageLabel: '1d',
      seats: null,
      nowLabel: 'parked · 1d',
    },
  ],
})
fixture.needsYou = [
  {
    obligationId: 'obl-look-1',
    sessionId: 's-oauth',
    title: 'Bash — allow?',
    question: '"Fix OAuth callback" asks to run Bash — allow?',
    projectLabel: 'Moodle',
    agentLabel: 'Mercury',
    ageLabel: '02m',
    ref: 'permission:req-look-1',
  },
]
fixture.counts.needsYou = 1
fixture.newSession.modelOptions = [
  { modelId: 'claude-fable-5', displayName: 'Fable 5' },
  { modelId: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
]
const fixturePath = join(scratch, 'board-controls-look-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

const sends: Send[] = [
  { data: 'run the overnight sweep', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 2 },
  { data: '\r', afterPrevTicks: 2 },
  { data: ESC, awaitText: "Past the machine's reading", requireAwait: true, awaitSettleTicks: 3, mark: 'seat-card' },
  { data: '\t', afterPrevTicks: 3 },
  { data: 'm', afterPrevTicks: 2, mark: 'live-legend' },
  { data: ESC, awaitText: 'MODEL —', requireAwait: true, awaitSettleTicks: 3, mark: 'model-picker' },
  { data: 'e', afterPrevTicks: 2 },
  { data: ESC, awaitText: 'EFFORT —', requireAwait: true, awaitSettleTicks: 3, mark: 'effort-picker' },
  { data: DOWN + DOWN + DOWN + DOWN + DOWN, afterPrevTicks: 2 },
  { data: '\t\t\t', afterPrevTicks: 2, mark: 'parked-legend' },
  { data: '\r', afterPrevTicks: 2 },
  { data: 'q', afterPrevTicks: 4, mark: 'cut-no-yn' },
]
const out = join(OUT_DIR, 'board-controls-120x40.json')
const cfgPath = join(scratch, 'vshot-cfg.json')
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total: 46, cols: 120, rows: 40, out }))
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf8',
  timeout: vshotBudgetMs(240_000),
  env: {
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
  },
})
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${(res.stderr ?? '').slice(-600)}`)
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

console.log('L1 — the seat-overload card + the 5/4· chip')
check('the card is the STANDARD consent frame with the ruled title', has(mk('seat-card'), "Past the machine's reading"))
check('the reading sentence is capacityCheck\'s own (never a bare number)', has(mk('seat-card'), "this machine's reading: 4 seats"))
check('the over line names the next session over the reading', has(mk('seat-card'), 'session 5 over'))
check('the No leg dispatches nothing, said plainly', has(mk('seat-card'), 'No, dispatch nothing (esc)'))
check('the rail chip wears the over mark while the demand runs past the reading', has(mk('seat-card'), '5/4· seats'))
console.log('L2 — the present-moves key-map row')
check('a LIVE selection prints i interrupt · p pause · m model · e effort', has(mk('live-legend'), 'i interrupt') && has(mk('live-legend'), 'p pause') && has(mk('live-legend'), 'm model') && has(mk('live-legend'), 'e effort'))
check('a PARKED selection dims to its reason and drops the controls', has(mk('parked-legend'), 'parked · ↵ brings it back') && !has(mk('parked-legend'), 'i interrupt'))
console.log('L3 — the row pick modal: model (haiku included) and effort (the shared ladder)')
check('the declared modal paints with the session title', has(mk('model-picker'), 'MODEL —'))
check('the session-arm rows ride it — haiku included per the standing amendment', has(mk('model-picker'), 'Haiku 4.5') && has(mk('model-picker'), 'Fable 5'))
check('the picker legend says switch/keep', has(mk('model-picker'), '↵ switches this session'))
check('e opens the EFFORT picker in the same grammar (the WARMRUN rider)', has(mk('effort-picker'), 'EFFORT —') && has(mk('effort-picker'), 'xhigh'))
check("the effort legend says set/keep", has(mk('effort-picker'), "↵ sets this session's effort"))
console.log('L4 — the cut: no y/n grammar after ↵ on a permission row')
check('no board key answers — the y/n grammar paints NOWHERE', !has(mk('cut-no-yn'), 'y allows') && !has(mk('cut-no-yn'), 'n denies'))
check('the board stands (the route is a hop, never a context)', has(mk('cut-no-yn'), 'SESSIONS'))

console.log(failures === 0 ? '\nboard-controls look: GREEN' : `\nboard-controls look: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
