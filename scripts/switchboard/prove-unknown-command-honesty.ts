#!/usr/bin/env bun
// ============================================================================
//  prove-unknown-command-honesty — an unregistered /name answers the SCREEN's
//  own sentence, display-only, on the daemon-hosted seat.
//
// THE FIND (driven): "/theme" typed into a
//  face-↵ chat fell through the one dispatch rule as session WORDS; the
//  runner's table answered and the refusal PERSISTED as a user row spelled
//  "[<handle>] ❯ Unknown skill: theme" — the transcript claimed the operator
//  typed the refusal, in the runner's skill vocabulary (the type contract
//  says: never "Unknown skill" for typed commands). The gated-command fix's
//  sibling: resolveUnknownSlashName + unknownCommandLine at the same seam.
//
//  §1 pure laws over the resolver (name/alias/path/escape gates) and the
//     sentence. §2 the DRIVE on the built bundle: '/frobnicate' ↵ in a
//     daemon-hosted chat — the screen's sentence paints; POISON needles: no
//     'Unknown skill' anywhere, the transcript byte-clean of the name and
//     of both refusal spellings, zero wire hits.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'

// Hermetic BEFORE any src import.
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
  const { resolveUnknownSlashName, unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.js')
  const table = [
    { name: 'model', type: 'local', description: 'pick', aliases: [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'model' },
    { name: 'exit', type: 'local', description: 'leave', aliases: ['quit'], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'exit' },
  ] as never[]
  check('an unregistered name resolves ("/frobnicate")', resolveUnknownSlashName('/frobnicate', table) === 'frobnicate')
  check('a registered name never resolves', resolveUnknownSlashName('/model', table) === undefined)
  check('an alias never resolves', resolveUnknownSlashName('/quit', table) === undefined)
  check('the // escape never resolves (words to the session)', resolveUnknownSlashName('//frobnicate', table) === undefined)
  check('an existing path never resolves (/tmp is a prompt)', resolveUnknownSlashName('/tmp', table) === undefined)
  check('a non-name shape never resolves (/what?now)', resolveUnknownSlashName('/what?now', table) === undefined)
  check('arguments ride the name ("/frobnicate now")', resolveUnknownSlashName('/frobnicate now', table) === 'frobnicate')
  const line = unknownCommandLine('frobnicate', table)
  check('the sentence is the SCREEN\'s: "Unknown command: /frobnicate … /help lists commands"', line.startsWith('Unknown command: /frobnicate') && line.includes('/help lists commands'), line)
  check('POISON: the sentence never wears the runner\'s skill spelling', !line.includes('Unknown skill'))
}

console.log('§2 the drive: the daemon-hosted seat answers display-only')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
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
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1200, '\r'), // 0 New Session (the daemon-hosted seat)
  after(3600, 'hello persisted turn'), // 1
  after(4200, '\r'), // 2 → a real turn persists
  after(7200, '/frobnicate'), // 3
  after(7900, '\r'), // 4 → the screen's sentence, display-only
]
const WALL_S = driveWallSeconds(sends)
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '110', '--rows', '32', '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
      // env drops the job-wide knob and ptydrive falls back to scale 1 -
      // authored-time sends race 3x-slow hosted boots (the undelivered-sends
      // class; gate run 3's arena zero-observation shapes). Forward it.
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_SPLASH: 'off',
      MERCURY_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'),
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
// exact-pid reap.
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
  }
  const supFile = join(daemonDir, 'supervisor.json')
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
  const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '110', '32', String(submitAt + 1200), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const joined = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens.map(s => s.rows.join('\n')).join('\n@@@\n')
  check('the screen answers with its own sentence', /Unknown command: \/frobnicate/.test(joined), joined.split('\n').filter(r => /frobnicate/i.test(r)).map(r => r.trim().slice(0, 100)).join(' | '))
  check("POISON: the runner's skill spelling never paints", !/Unknown skill/.test(joined))
  const projectsDir = join(configDir, 'projects')
  let transcriptBytes = ''
  if (existsSync(projectsDir)) {
    for (const proj of readdirSync(projectsDir)) {
      for (const f of readdirSync(join(projectsDir, proj))) {
        if (f.endsWith('.jsonl')) transcriptBytes += readFileSync(join(projectsDir, proj, f), 'utf8')
      }
    }
  }
  check('the real turn persisted (the transcript exists)', transcriptBytes.includes('hello persisted turn'))
  check('NO transcript byte carries the unknown line or either refusal spelling', !transcriptBytes.includes('frobnicate') && !transcriptBytes.includes('Unknown skill'))
  check('the wire never saw the name', api.requests.every((r: { raw: string }) => !r.raw.includes('frobnicate')))
}
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-unknown-command-honesty: ALL LAWS HOLD' : `\nprove-unknown-command-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
