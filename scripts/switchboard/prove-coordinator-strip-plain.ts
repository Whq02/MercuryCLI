#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-stripplain-${process.pid}`)
const WORK = path.join(RUN_HOME, 'work')
const MERCURY_HOME = path.join(RUN_HOME, 'proof-home')
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(MERCURY_HOME, { recursive: true })
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [WORK]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: ['sk-ant-stripplain-probe'.slice(-20)], rejected: [] },
    switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 5 },
  }),
)
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))

const { appendCoordinatorConversation } = await import(
  '../../src/services/concourse/coordinatorConversation.ts'
)
const SEEDED_WORDS = 'tighten the parser next'
await appendCoordinatorConversation(
  {
    id: 'strip-plain-1',
    role: 'coordinator',
    text: 'Ready to **tighten the parser next** — start with `LineScanner` and *measure* first.',
    ts: Date.now(),
  },
  RUN_HOME,
)

console.log('============================================================')
console.log(' collapsed coordinator strip — inline markdown as words')
console.log('============================================================')

const out = path.join(RUN_HOME, 'grid.json')
const SHIFT_RIGHT = `${String.fromCharCode(27)}[1;2C`
const cfg = {
  argv: ['node', DIST],
  cwd: WORK,
  sends: [{ atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: SHIFT_RIGHT }],
  readyText: ['tighten the parser next'],
  stableTicks: 5,
  total: 150,
  cols: 100,
  rows: 40,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  MERCURY_CONCOURSE: 'always',
  ANTHROPIC_API_KEY: 'sk-ant-stripplain-probe',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
  MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
  MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
  MERCURY_TABULA_MINERVA: '0',
  MERCURY_HOME: MERCURY_HOME,
}
delete childEnv.NODE_ENV
delete childEnv.ANTHROPIC_AUTH_TOKEN

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(120_000),
  cwd: WORK,
  env: childEnv,
})
let gridRows: string[] = []
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  gridRows = payload.grid.map(r => r.map(c => c.c || ' ').join(''))
}
const gridText = gridRows.join('\n')

check('C1 the stacked board painted (the coordinator composer placeholder; the retired tab-to-focus hint left the estate)', gridText.includes('describe a task'), `vshot status=${res.status}\n${gridRows.slice(-10).join('\n')}`)
check('C2 the seeded reply reached the strip as words', gridText.includes(SEEDED_WORDS), gridRows.filter(r => r.includes('COORDINATOR') || r.includes('tighten')).join('\n'))
const stripLines = gridRows.filter(r => r.includes(SEEDED_WORDS) || r.includes('tighten the'))
check(
  'C3 no literal inline marker on the painted strip',
  stripLines.length > 0 && stripLines.every(r => !r.includes('**') && !r.includes('`')),
  stripLines.join('\n'),
)

if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
else console.log(`[forensics] world kept: ${RUN_HOME}`)
console.log(failures === 0 ? '\nprove-coordinator-strip-plain: ALL LAWS HOLD' : `\nprove-coordinator-strip-plain: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
