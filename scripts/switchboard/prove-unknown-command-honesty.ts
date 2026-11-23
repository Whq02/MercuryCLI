#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { afterBootFace } from '../lib/bootFace.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unknown-cmd-pure-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the resolver and the sentence')
{
  const { resolveUnknownSlashName, unknownCommandLine } = await import('../../src/engine/user-input/processSlashCommand.js')
  const table = [
    { name: 'model', type: 'local', description: 'pick', aliases: [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'model' },
    { name: 'exit', type: 'local', description: 'leave', aliases: ['quit'], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'exit' },
  ] as never[]
  check('an unregistered name resolves ("/frobnicate")', resolveUnknownSlashName('/frobnicate', table) === 'frobnicate', 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx so a slash name absent from the table returns that name')
  check('a registered name never resolves', resolveUnknownSlashName('/model', table) === undefined, 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx: a name findCommand matches must return undefined')
  check('an alias never resolves', resolveUnknownSlashName('/quit', table) === undefined, 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx: an alias found by findCommand must return undefined')
  check('the // escape never resolves (words to the session)', resolveUnknownSlashName('//frobnicate', table) === undefined, 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx: input starting with // must return undefined')
  check('an existing path never resolves (/tmp is a prompt)', resolveUnknownSlashName('/tmp', table) === undefined, 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx: a slash word that isExistingPath must return undefined')
  check('a non-name shape never resolves (/what?now)', resolveUnknownSlashName('/what?now', table) === undefined, 'fix looksLikeCommand in src/engine/user-input/processSlashCommand.tsx: a name outside letters, digits, colon, underscore and dash must return undefined')
  check('arguments ride the name ("/frobnicate now")', resolveUnknownSlashName('/frobnicate now', table) === 'frobnicate', 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx: the name is the text up to the first space')
  const line = unknownCommandLine('frobnicate', table)
  check('the sentence is the SCREEN\'s: "Unknown command: /frobnicate … /help lists commands"', line.startsWith('Unknown command: /frobnicate') && line.includes('/help lists commands'), line.startsWith('Unknown command: /frobnicate') && line.includes('/help lists commands') ? line : `${line} — fix the returned sentence of unknownCommandLine in src/engine/user-input/processSlashCommand.tsx`)
  check('POISON: the sentence never wears the runner\'s skill spelling', !line.includes('Unknown skill'), 'fix unknownCommandLine in src/engine/user-input/processSlashCommand.tsx so its sentence says Unknown command, never the skill spelling')
}

console.log('§2 the drive: the daemon-hosted seat answers display-only')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  const missing = `the drive needs the POSIX pty capture driver (scripts/streaming/ptydrive.py); this host has ${driver.kind === 'unavailable' ? driver.reason : `the ${driver.kind} driver`}`
  if (resolveExecutionProfile(REPO).kind === 'hosted-gate') check('§2 the hosted gate drives the daemon-hosted seat', false, missing)
  else console.log(`  [SKIP] §2 ${missing}`)
  console.log(failures === 0 ? '\nprove-unknown-command-honesty: ALL LAWS HOLD' : `\nprove-unknown-command-honesty: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'unknown-cmd-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'unknown-cmd-cwd-')))
const configDir = join(home, '.mercury')
const daemonDir = join(home, 'daemon')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
  }),
)
const api = await startFixtureApi([
  { kind: 'text', text: 'The fixture answers.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const after = (needle: string, ms: number, payload: string): string => `after:${needle}:${ms}:${payload}`
const sends = [
  afterBootFace(1200, '\r'),
  after('Type a prompt', 600, 'hello persisted turn'),
  after('~❯ hello persisted turn', 400, '\r'),
  after('The fixture answers.', 800, '/frobnicate'),
  after('~❯ /frobnicate', 500, '\r'),
]
const WALL_S = driveWallSeconds(sends, { bootMs: 10_700 })
const drive = join(home, 'drive.jsonl')
const nodeBin = nodeBinPath()
const child = spawn(
  driver.python,
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '110', '--rows', '32', '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_SPLASH: 'off',
      MERCURY_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
    },
  },
)
let driverOut = ''
child.stdout.on('data', d => (driverOut += d))
child.stderr.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WALL_S * 1000) + 22_000)
await driverClosed(child)
clearTimeout(killer)
await api.close()
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
  }
  const supFile = join(daemonDir, 'daemon.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM') } catch {} }
  }
} catch {}

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
check('the drive ladder fired whole', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)
if (sendRecs.length === sends.length) {
  const submitAt = Math.round((sendRecs[4]!.sent! - firstOut))
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '110', '32', String(submitAt + 1200), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const joined = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens.map(s => s.rows.join('\n')).join('\n@@@\n')
  check('the screen answers with its own sentence', /Unknown command: \/frobnicate/.test(joined), joined.split('\n').filter(r => /frobnicate/i.test(r)).map(r => r.trim().slice(0, 100)).join(' | ') + (/Unknown command: \/frobnicate/.test(joined) ? '' : ' — the screen did not paint the sentence: check the unknownName branch of src/screen/chat/submit/submitLine.ts (resolveUnknownSlashName, paintScreenCommandReceipt)'))
  check("POISON: the runner's skill spelling never paints", !/Unknown skill/.test(joined), 'an Unknown skill line reached the screen: the slash line must be answered by the unknownName branch of src/screen/chat/submit/submitLine.ts before it reaches the runner')
  const projectsDir = join(configDir, 'projects')
  let transcriptBytes = ''
  if (existsSync(projectsDir)) {
    for (const proj of readdirSync(projectsDir)) {
      for (const f of readdirSync(join(projectsDir, proj))) {
        if (f.endsWith('.jsonl')) transcriptBytes += readFileSync(join(projectsDir, proj, f), 'utf8')
      }
    }
  }
  check('the real turn persisted (the transcript exists)', transcriptBytes.includes('hello persisted turn'), 'no transcript .jsonl under the scratch config projects folder holds the first prompt: the drive did not submit it, so check the send ladder')
  check('NO transcript byte carries the unknown line or either refusal spelling', !transcriptBytes.includes('frobnicate') && !transcriptBytes.includes('Unknown skill'), 'the unknown slash line was persisted: the unknownName branch of src/screen/chat/submit/submitLine.ts must return before the line is recorded')
  check('the wire never saw the name', api.requests.every((r: { raw: string }) => !r.raw.includes('frobnicate')), 'the unknown slash name reached the API: the unknownName branch of src/screen/chat/submit/submitLine.ts must consume the line and not send it')
}
removeScratch(home)
removeScratch(cwd)
console.log(failures === 0 ? '\nprove-unknown-command-honesty: ALL LAWS HOLD' : `\nprove-unknown-command-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
