#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { stringWidth } from '../../src/ink/stringWidth.ts'

const REPO = path.resolve(import.meta.dir, '..', '..')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] !== undefined ? path.resolve(process.argv[distArg + 1]!) : path.join(REPO, 'dist/mercury.mjs')
if (!existsSync(DIST)) {
  console.log('FAIL build the product before running the drive')
  process.exit(1)
}
const COLS = 80
const ROWS = 21
const LANDING_NOTICE = 'the session is landing — your line sends when it lands'
const TAIL = '/model to return'
const GPT_REPLY = 'sol answers from the fixture'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-failover-rows-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-failover-rows-probe-key'
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
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
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
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# failover rows drive fixture\n')

const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn('node', [path.join(REPO, 'scripts/journey/cap-offer-fixture-server.ts'), captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), vshotBudgetMs(15_000))
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
const childEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: RUN_HOME,
  TMPDIR: realpathSync(tmpdir()),
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/zsh',
  MERCURY_CONFIG_DIR: RUN_HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:9',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER: 'clam',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_OPERATOR: 'sam',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_DESKTOP_DRIVER: 'none',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
  MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
  MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
  MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  MERCURY_FAILOVER_LINE_MS: '120000',
  MERCURY_CONNECTOR_TRACE: path.join(RUN_HOME, 'connector-trace.jsonl'),
  ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
type Payload = { grid: Grid; sendReceipts?: Array<{ atTick?: number }>; marks?: Mark[]; endReason?: string }
const rowsOf = (grid: Grid): string[] => grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))

const sends = [
  { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'boot' },
  { afterPrevTicks: 1, data: '', mark: 'landing-1' },
  { afterPrevTicks: 1, data: 'hello sol\r', mark: 'landing-send' },
  { afterPrevTicks: 1, data: '', mark: 'landing-2' },
  { afterPrevTicks: 2, data: '', mark: 'landing-3' },
  { requireAwait: true, awaitText: 'OpenAI usage window', awaitSettleTicks: 4, data: '\r', mark: 'offer' },
  { requireAwait: true, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'confirm' },
  { requireAwait: true, awaitText: 'failover lane', awaitSettleTicks: 4, data: '', mark: 'settled' },
]
const out = path.join(RUN_HOME, 'grid.json')
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--model', 'gpt-5.6-sol'], cwd: FIXTURE_CWD, sends, stableTicks: 4, total: 400, cols: COLS, rows: ROWS, out }))
console.log(`failover compact rows: world ${RUN_HOME} (dist: ${DIST})`)
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(240_000), cwd: FIXTURE_CWD, env: childEnv })
writeFileSync(path.join(RUN_HOME, 'engine.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`)
const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
const marks = new Map<string, string[]>()
for (const mark of payload?.marks ?? []) {
  const rows = rowsOf(mark.grid)
  marks.set(mark.label, rows)
  writeFileSync(path.join(RUN_HOME, `frame-${mark.label}.txt`), rows.join('\n'))
}
if (payload !== null) writeFileSync(path.join(RUN_HOME, 'frame-final.txt'), rowsOf(payload.grid).join('\n'))
const frame = (label: string): string[] => marks.get(label) ?? []
const printFrame = (label: string): void => {
  console.log(`┌── ${label} ──`)
  for (const row of frame(label)) console.log(`│${row}`)
  console.log('└──')
}

check('the world booted, the line was typed at the landing, the offer stood and the handoff landed (engine exit 0)', res.status === 0 && ['boot', 'landing-send', 'offer', 'confirm', 'settled'].every(l => marks.has(l)), `exit=${res.status} marks=${[...marks.keys()].join(',')} endReason=${payload?.endReason ?? '?'}; ${path.join(RUN_HOME, 'engine.log')}`)

for (const label of ['landing-1', 'landing-send', 'landing-2', 'landing-3']) printFrame(label)
const landingFrames = ['landing-1', 'landing-send', 'landing-2', 'landing-3'].map(frame)
const held = landingFrames.filter(rows => rows.some(row => row.includes(LANDING_NOTICE)))
const underReady = held.filter(rows => (rows[0] ?? '').includes('● ready'))
check('a line typed right after ↵ on New Session is held for the landing: the notice stands on at least one of the frames that follow', held.length > 0, landingFrames.map(rows => rows[rows.length - 1] ?? '').join(' | '))
check('the landing window is on the frames: the band names the wordmark and no ● ready while no session holds the slot', landingFrames.some(rows => (rows[0] ?? '').includes('✶ Mercury') && !(rows[0] ?? '').includes('● ready')), landingFrames.map(rows => rows[0] ?? '').join(' | '))
check('the notice never stands under a ● ready band before the held line has landed: every such frame carries the sent line on the transcript (the notice keeps its own seconds after the landing)', underReady.every(rows => rows.some(row => row.includes('❯ hello sol'))), underReady.map(rows => `${rows[0] ?? ''} / ${rows.find(row => row.includes('❯')) ?? 'no transcript row'}`).join(' | '))
check('the held line sent when the session landed and was answered', frame('offer').some(row => row.includes(GPT_REPLY)) || frame('settled').some(row => row.includes(GPT_REPLY)), frame('offer').join(' | ').slice(0, 300))
check('once the session has landed the band reads ● ready again', (frame('offer')[0] ?? '').includes('● ready'), frame('offer')[0] ?? '')

printFrame('settled')
const sentence = frame('settled').find(row => row.includes('failover lane'))
check('the failover sentence stands above the composer at 80×21', sentence !== undefined, frame('settled').join(' | ').slice(0, 300))
check('the sentence keeps its /model to return tail at the row\'s end', sentence !== undefined && sentence.endsWith(TAIL) && stringWidth(sentence) <= COLS, sentence)
check('the sentence is cut to what fits, an ellipsis closing the cut, and begins as before', sentence !== undefined && sentence.includes('…') && sentence.trimStart().startsWith('on the anthropic failover lane · Fable 5.1'), sentence)

console.log(`\n${failures === 0 ? '✅' : '❌'} failover-compact-rows-drive: ${checks} checks, ${failures} failed · frames under ${RUN_HOME}`)
fixture.kill()
process.exit(failures === 0 ? 0 : 1)
