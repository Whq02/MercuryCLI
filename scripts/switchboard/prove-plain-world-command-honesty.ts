#!/usr/bin/env bun
// ============================================================================
//  prove-plain-world-command-honesty — a concourse-only command typed in the
//  PLAIN WORLD answers the router's own sentence on the SCREEN seat.
//
//  The chat-mode law: the eight
//  needsConcourse commands leave the table AND answer honestly when typed.
//  The regression this pins: the REPL's enabled
//  resolver answered undefined for a plain-world-gated command, so the ONE
//  DISPATCH RULE relayed the line to the session runner as WORDS — the
//  runner's table is never a plain world, so the answer came back as the
//  HEADLESS-FORM refusal ("…no headless form") and persisted as a user row.
//
//  POISON (the pre-fix world): the headless sentence on screen, and the
//  command line (or its refusal) persisted into the session transcript.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'plainworld-honesty-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'plainworld-honesty-cwd-')))
const configDir = join(home, '.claude')
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
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()

// --chat boot: menu → ↵ New Session → one settled fixture turn → /party ↵.
const sends = [
  'after:↑↓ choose:1500:\r',
  'after:↑↓ choose:4500:hello plain world',
  'after:↑↓ choose:5700:\r',
  'after:↑↓ choose:10500:/party',
  'after:↑↓ choose:11700:\r',
]
const child = spawn(
  '/usr/bin/python3',
  [
    join(REPO, 'scripts', 'streaming', 'ptydrive.py'),
    '--cols', '110', '--rows', '32', '--seconds', '17', '--out', drive,
    ...sends.flatMap(s => ['--send', s]),
    '--', nodeBin, DIST, '--chat',
  ],
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
const killer = setTimeout(() => child.kill('SIGKILL'), 17_000 + 22_000)
await new Promise<void>(r => child.on('exit', () => r()))
clearTimeout(killer)
await api.close()

// exact-pid reap: runners from the records file, then the owned daemon.
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number; endedAt?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) {
      if (rec.pid !== undefined && rec.endedAt === undefined) {
        try { process.kill(rec.pid, 'SIGTERM') } catch { /* gone */ }
      }
    }
  }
  const supFile = join(daemonDir, 'supervisor.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  }
} catch { /* best effort — scratch dirs die below */ }

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
check('the drive ladder fired whole', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}`)
const submitAt = Math.round((sendRecs[4]?.sent ?? firstOut) - firstOut)

const res = spawnSync(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '110', '32', String(submitAt + 1200), String(submitAt + 2400), '-1'],
  { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
)
if (res.status !== 0) {
  console.error(`screengrab failed: ${res.stderr}`)
  process.exit(1)
}
const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
const joined = screens.map(s => s.rows.join('\n')).join('\n@@@\n')

// §1 the router's sentence, on screen, at the submit.
check(
  '§1 the honest plain-world sentence paints (the router speaks)',
  /opens a Session Concourse surface/.test(joined) && /off in this boot/.test(joined),
)
// §2 poison — the runner's headless refusal never paints for a typed
//    plain-world command.
check('§2 POISON: the headless-form refusal never paints', !/no headless form/.test(joined))
// §3 nothing persisted: the transcript carries neither the command line nor
//    either refusal sentence (the receipt is display-only).
const projectsDir = join(configDir, 'projects')
let transcriptBytes = ''
if (existsSync(projectsDir)) {
  for (const proj of readdirSync(projectsDir)) {
    const pd = join(projectsDir, proj)
    for (const f of readdirSync(pd)) {
      if (f.endsWith('.jsonl')) transcriptBytes += readFileSync(join(pd, f), 'utf8')
    }
  }
}
check('§3 a transcript exists (the seeded turn persisted)', transcriptBytes.includes('hello plain world'))
check(
  '§3 NO transcript byte carries the gated command or a refusal sentence',
  !transcriptBytes.includes('/party') && !transcriptBytes.includes('no headless form') && !transcriptBytes.includes('Session Concourse surface'),
)
// §3b the chat's status row never doubles the stage-1 tag's tail (the
//     finding: "new session · X · ready · X · ready — your words go…" on every
//     blank chat — the tag already carried the project and the state).
const doubled = /· ready · [^\n·]+ · ready/
check('§3b the status row never repeats "· <project> · ready" twice', !doubled.test(joined), joined.split('\n').filter(r => doubled.test(r)).map(r => r.trim().slice(0, 110)).join(' | ') || 'clean')
// §3c L16 stage 2 on the chat seat: after the first words the status row's
//     tag is the chat's own first line, never the frozen "new session" fact
//     (the connector reads the record's title live).
const statusRows = joined.split('\n').filter(r => /· ready|· thinking|· running a tool|· replying|esc interrupts/.test(r))
check('§3c after the first words the status row names them (stage 2), not "new session"', statusRows.length > 0 && statusRows.some(r => /hello plain world/.test(r)) && !statusRows.some(r => /new session ·/.test(r)), statusRows.map(r => r.trim().slice(0, 100)).slice(0, 2).join(' | ') || 'no status row')
// §4 the wire never saw the line. The needle excludes the harness-map's
// resource docs (mercury://party) — the TYPED line is a bare /party.
const typedNeedle = /(?<![:/\w])\/party\b/
const wireHits = api.requests.filter((r: { raw: string }) => typedNeedle.test(r.raw))
check('§4 the wire never saw /party', wireHits.length === 0, `${wireHits.length} of ${api.requests.length}`)
for (const hit of wireHits.slice(0, 2)) {
  const raw = (hit as { raw: string }).raw
  const idx = raw.search(typedNeedle)
  console.log(`    wire evidence: …${raw.slice(Math.max(0, idx - 220), idx + 120).replace(/\n/g, ' ')}…`)
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-plain-world-command-honesty: ALL LAWS HOLD' : `\nprove-plain-world-command-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
