#!/usr/bin/env bun
// gate-watch: src/components/MercuryHome.tsx src/components/SwitchboardTagBar.tsx src/components/BootSplashScreen.tsx
// gate-watch: src/utils/accounts/sessionSignIn.ts src/hooks/useSessionSignInGate.ts src/services/wallet/wallet.ts assets/splash/splash-core.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 700) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-signed-out-says-so: SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
if (!existsSync(DIST)) {
  console.log('prove-signed-out-says-so: SKIPPED — dist/mercury.mjs is not built')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'signed-out-says-so-'))
const CWD = join(scratch, 'cwd')
mkdirSync(CWD, { recursive: true })
writeFileSync(join(CWD, 'README.md'), '# a small folder\n')

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
const rowsWith = (text: string, needle: string): string[] => text.split('\n').filter(l => l.includes(needle))
const statusRow = (text: string): string => text.split('\n').find(l => l.includes('⇧← back')) ?? ''

function childEnv(home: string, signedIn: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_UPDATE_NOTICE: '0',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    BROWSER: '/usr/bin/true',
  }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL', 'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI']) delete env[key]
  if (signedIn) env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
  return env
}

function drive(tag: string, signedIn: boolean, sendPrompt: boolean): { marks: Record<string, string>; endReason: string; stderr: string } {
  const home = join(scratch, `${tag}-home`)
  seedFirstRun(home, [CWD])
  const sends: unknown[] = [
    { data: '', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4, mark: 'home' },
    { data: '\r', afterPrevTicks: 2 },
    { data: '', atTick: 999, awaitText: '↵ sends', requireAwait: true, awaitSettleTicks: 10, mark: 'chat' },
  ]
  if (sendPrompt) {
    sends.push({ data: 'hello there\r', afterPrevTicks: 5 })
    sends.push({ data: '', atTick: 999, awaitText: '/logins', minTick: 1, awaitSettleTicks: 10, mark: 'after-send' })
  }
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--chat'], sends, total: 300, cols: 120, rows: 40, out: grid, title: tag }))
  const r = spawnSync(driver.python, [VSHOT, cfgPath], { env: childEnv(home, signedIn), cwd: CWD, encoding: 'utf8', timeout: vshotBudgetMs(300 * 200 * 2.5 + 60_000) })
  const marks: Record<string, string> = {}
  let endReason = ''
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
    for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
    endReason = payload.endReason ?? ''
  }
  if (frameDir) for (const [label, text] of Object.entries(marks)) writeFileSync(join(frameDir, `${tag}-${label}.txt`), `${text}\n`)
  return { marks, endReason, stderr: (r.stderr ?? '').trim() }
}

try {
  section('§1 a home with no sign-in anywhere: the home menu, the chat and the status row all say so, and a prompt answers with the way in')
  const keyless = drive('keyless', false, true)
  const home = keyless.marks.home ?? ''
  const chat = keyless.marks.chat ?? ''
  const afterSend = keyless.marks['after-send'] ?? ''
  check('the boot face painted', home.includes('New Session'), keyless.stderr.slice(-400))
  check('the home menu\'s Logins row says not signed in', rowsWith(home, 'Logins').some(l => l.includes('not signed in')), rowsWith(home, 'Logins').join(' | '))
  check('the chat painted', chat.includes('↵ sends'), keyless.stderr.slice(-400))
  check('the chat\'s hero row says not signed in and names /logins', rowsWith(chat, 'not signed in').some(l => l.includes('○ not signed in · /logins connects')), rowsWith(chat, 'signed in').join(' | '))
  check('…and never says ready', !chat.includes('● ready'), rowsWith(chat, 'ready').join(' | '))
  check('the status row reads "not signed in · /logins" before the model', /^\s*not signed in · \/logins · /.test(statusRow(chat)), statusRow(chat))
  check('a prompt sent while signed out answers with the way in (/logins), not a provider error', afterSend.includes('hello there') && rowsWith(afterSend, '/logins').length > 0 && !/401|authentication_error|invalid x-api-key|ECONNREFUSED/.test(afterSend), rowsWith(afterSend, 'hello there').concat(rowsWith(afterSend, 'logins')).join(' | '))

  section('§2 a signed-in home keeps its words: Logins counts the sign-in, the hero row and the status row read ready')
  const signedIn = drive('signed-in', true, false)
  const homeIn = signedIn.marks.home ?? ''
  const chatIn = signedIn.marks.chat ?? ''
  check('the boot face painted', homeIn.includes('New Session'), signedIn.stderr.slice(-400))
  check('the Logins row counts the sign-in and never says not signed in', rowsWith(homeIn, 'Logins').some(l => /\d+ of \d+ signed in/.test(l)) && !homeIn.includes('not signed in'), rowsWith(homeIn, 'Logins').join(' | '))
  check('the chat\'s hero row reads ready', chatIn.includes('● ready · type a prompt, or / for commands'), rowsWith(chatIn, 'ready').join(' | '))
  check('the status row reads ready before the model', /^\s*ready · /.test(statusRow(chatIn)), statusRow(chatIn))
  check('nothing on the signed-in chat says not signed in', !chatIn.includes('not signed in'), rowsWith(chatIn, 'signed in').join(' | '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-signed-out-says-so — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-signed-out-says-so — all checks pass')
process.exit(0)
