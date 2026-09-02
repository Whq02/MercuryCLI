#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'contract-offer-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'contract-offer-cwd-')))
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
const FIRST_ANSWER = 'The first session answered with a sentence long enough that only a transcript paints its tail whole.'
const TRANSCRIPT_TAIL = /paints its tail whole/
const api = await startFixtureApi([
  { kind: 'text', text: FIRST_ANSWER, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const N = '↑↓ choose'
const CONTRACT_WORDS = 'Ship the widget; touch nothing else.'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1200, '\r'),
  after(3600, 'first words here'),
  after(4200, '\r'),
  after(7000, `${ESC}[1;2D`),
  after(8000, '\t'),
  after(8800, 'n'),
  after(10200, ESC),
  after(13600, `${ESC}[1;2D`),
  after(14600, '\t'),
  after(15400, 'n'),
  after(16600, '\r'),
  after(17600, CONTRACT_WORDS),
  after(19000, '\r'),
]
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '24', '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
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
const killer = setTimeout(() => child.kill('SIGKILL'), 24_000 + 22_000)
await new Promise<void>(r => child.on('exit', () => r()))
clearTimeout(killer)
await api.close()
const reaped: number[] = []
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM'); reaped.push(rec.pid) } catch {} }
  }
  const supFile = join(daemonDir, 'supervisor.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM'); reaped.push(pid) } catch {} }
  }
} catch {}
console.log(`  reaped pids: ${reaped.join(',') || 'none live'}`)

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
check('the drive ladder fired whole', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${driverOut.slice(-250)}` : ''}`)
if (sendRecs.length === sends.length) {
  const at = (i: number): number => Math.round(sendRecs[i]!.sent! - firstOut)
  const res = spawnSync(
    '/usr/bin/python3',
    [
      join(REPO, 'scripts', 'streaming', 'screengrab.py'),
      drive,
      '120',
      '40',
      String(at(2) + 3000),
      String(at(5) + 900),
      String(at(6) + 2500),
      String(at(10) + 900),
      String(at(11) + 900),
      String(at(12) + 2500),
      '-1',
    ],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const [firstChat, cardFrame, afterEsc, fieldFrame, typedFrame, afterBirth, fin] = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens.map(s => s.rows.join('\n'))
  check('§0 the transcript needle paints in the first chat (the sibling-transcript poison is never vacuous)', TRANSCRIPT_TAIL.test(firstChat!), firstChat!.split('\n').find(r => /answered/.test(r))?.trim().slice(0, 110) ?? '')
  check('§1 the n tab raises the offer card in the live-view pane', /Start with a contract\?/.test(cardFrame!) && /No, start it plain \(esc\)/.test(cardFrame!))
  check('§2 esc answers No THROUGH THE CARD — the NEW blank chat is focused (stage-1 tag)', /new session ·/.test(afterEsc!) && /· ready/.test(afterEsc!), (afterEsc ?? '').split('\n').find(r => /· ready|new session/.test(r))?.trim().slice(0, 110) ?? '')
  check("§2c POISON: it is never the OLD chat (the pre-fix esc landed the first session's transcript)", !/first words here/.test(afterEsc!))
  check('§4 ↵ on Yes opens "What is the contract?" INSIDE the standing card', /What is the contract\?/.test(fieldFrame!) && /Start with a contract\?/.test(fieldFrame!), fieldFrame!.split('\n').find(r => /contract/i.test(r))?.trim().slice(0, 110) ?? '')
  check("§4b POISON: no sibling transcript paints behind the card (the first session's answer tail is absent)", !TRANSCRIPT_TAIL.test(fieldFrame!) && !TRANSCRIPT_TAIL.test(typedFrame!))
  check('§4c POISON: the retired live-composer context line never paints', !/write the contract here/.test(fieldFrame!) && !/write the contract here/.test(typedFrame!))
  check('§4d the words type INTO the card (the frame carries them with the question still standing)', /Ship the widget/.test(typedFrame!) && /What is the contract\?/.test(typedFrame!))
  check('§4e the field advertises its keys truthfully (↵ starts · esc plain)', /↵ starts the session under it/.test(typedFrame!) && /esc starts it plain/.test(typedFrame!))
  check('§5 ↵ births under the words — the NEW blank chat is focused (stage-1 tag)', /new session ·/.test(afterBirth!) && /· ready/.test(afterBirth!), (afterBirth ?? '').split('\n').find(r => /· ready|new session/.test(r))?.trim().slice(0, 110) ?? '')
  check('§5b POISON: the birth never lands the OLD chat', !/first words here/.test(afterBirth!) && !TRANSCRIPT_TAIL.test(afterBirth!))
  check('§2b/§5c the rows join the board (the final frame)', /new session/.test(fin!) || /3 live/.test(fin!))
  const workers = existsSync(join(daemonDir, 'concourse-workers.json')) ? (JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers?: Record<string, { endedAt?: number; contract?: { text?: string; status?: string } }> }) : { workers: {} }
  const live = Object.values(workers.workers ?? {}).filter(w => w.endedAt === undefined)
  check('§3 the records agree: THREE live sessions (two plain births, one under its contract)', live.length === 3, `${live.length}`)
  const contracted = live.filter(w => w.contract !== undefined)
  check("§5d exactly ONE record carries the contract — the card's words verbatim, drafted for the agent's ack", contracted.length === 1 && contracted[0]?.contract?.text === CONTRACT_WORDS && contracted[0]?.contract?.status === 'draft', JSON.stringify(contracted.map(w => w.contract)))
}
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-contract-offer-drive: ALL LAWS HOLD' : `\nprove-contract-offer-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
