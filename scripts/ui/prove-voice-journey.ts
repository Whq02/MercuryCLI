#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-voice-journey.ts — voice input driven on the BUILT
//  bundle in a real PTY, hermetic: a fixture recorder (a synthesized tone),
//  a loopback transcriber, and a zero-network tripwire on every child.
//
//  Legs, each a REAL boot of dist/mercury.mjs on a seeded scratch home:
//    §A the journey: /speak (status OFF) → /speak on → v (the footer:
//       ● recording · v or esc to stop) → v (transcribing…) → the canned
//       words are in the composer with the cursor at the END (a typed
//       character lands after them) → /speak off → v types the letter v.
//    §B a keyless home: /speak on → v answers the no-transcriber receipt
//       BEFORE any take (zero requests).
//    §C no backend (no pack, no recorder on PATH): v answers the no-backend
//       receipt.
//    §D the zero-network law: v starts a take, esc cancels it — the
//       transcriber sees NO request, and nothing left loopback.
// ============================================================================
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { synthesizeToneWav } from '../../src/services/voice/wav.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(ROOT, 'scripts', 'voice', 'voice-transcriber-fixture-server.ts')
const TRANSCRIPT = 'the quick brown fox jumps over the lazy dog'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the voice journey cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'voice-journey-'))
const shimDir = join(scratch, 'bin')
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\nexit 128\n`)
  chmodSync(path, 0o755)
}
const TONE = join(scratch, 'tone.wav')
writeFileSync(TONE, synthesizeToneWav({ seconds: 1, hz: 440 }))
const EMPTY_PACK = join(scratch, 'no-pack')
mkdirSync(EMPTY_PACK, { recursive: true })

/** The directory holding the `node` the PTY child boots on (the no-backend
 *  leg needs a PATH with node and WITHOUT any recorder). */
function nodeDir(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, 'node'))) return dir
  }
  const which = spawnSync('which', ['node'], { encoding: 'utf8' })
  return dirname((which.stdout ?? '').trim() || '/usr/local/bin/node')
}

// ── the child tripwire: log everything, refuse everything non-loopback ──────
const preload = join(scratch, 'tripwire.cjs')
writeFileSync(
  preload,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }
const isLocal = host => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === undefined || host === ''
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  const host = opts.host || 'localhost'
  if (isLocal(host)) { log('tcp-local ' + host + ':' + opts.port); return origConnect.apply(this, args) }
  log('tcp ' + host + ':' + opts.port)
  throw new Error('tripwire: tcp ' + host + ':' + opts.port)
}
const origTls = tls.connect
tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  const host = opts.host || opts.servername || 'localhost'
  if (isLocal(host)) { log('tls-local ' + host + ':' + (opts.port ?? '')); return origTls.apply(this, args) }
  log('tls ' + host + ':' + (opts.port ?? ''))
  throw new Error('tripwire: tls ' + host)
}
try { require('node:module').syncBuiltinESMExports() } catch {}
const origFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const target = typeof input === 'string' ? input : String((input && input.url) || input)
  let host = ''
  try { host = new URL(target).hostname } catch {}
  if (isLocal(host)) { log('fetch-local ' + target); return origFetch(input, init) }
  log('fetch ' + target)
  return Promise.reject(new Error('tripwire: fetch ' + target))
}
`,
)

const DEAD = 'http://127.0.0.1:9'
function childEnv(home: string, netlog: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    PROOF_NETLOG: netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_BASE_URL: DEAD,
    BROWSER: 'true',
    MERCURY_VOICE_BACKEND: 'fixture',
    MERCURY_VOICE_FIXTURE_WAV: TONE,
  }
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HF_TOKEN',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'MERCURY_VOICE_PACK_DIR',
    'MERCURY_VOICE_DEBUG_WAV_DIR',
    'MERCURY_OPENAI_API_BASE',
    'MERCURY_GEMINI_API_BASE',
    'NODE_ENV',
    'CI',
  ]) {
    delete env[key]
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

const netlines = (netlog: string): string[] =>
  existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(l => l.trim() !== '') : []
const nonLoopback = (lines: string[]): string[] =>
  lines.filter(l => !(l.startsWith('tcp-local') || l.startsWith('tls-local') || l.includes('-local.') || l.startsWith('fetch-local')))
const ledgerPosts = (ledger: string): string[] =>
  existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes(' POST ')) : []

interface Fixture {
  child: ChildProcess
  port: number
  ledger: string
}
async function startFixture(tag: string, delayMs: number): Promise<Fixture> {
  const ledger = join(scratch, `${tag}-ledger.log`)
  const child = spawn(process.execPath, ['run', FIXTURE, String(delayMs), ledger, TRANSCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
  })
  return { child, port, ledger }
}

interface DriveResult {
  status: number | null
  gridText: string
  marks: Record<string, string>
  stderr: string
}
function drive(tag: string, home: string, netlog: string, sends: unknown[], total: number, extraEnv: Record<string, string | undefined>): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  // The PLAIN WORLD (--chat): the Boot face and a chat with no Session
  // Concourse — a concourse boot hands the chat over to a daemon-hosted
  // session moments after New Session, and a command typed across that
  // handover lands in the session being replaced. The voice keys are the
  // composer's; the world they are proved in is the one without the race.
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--chat'], sends, total, cols: 120, rows: 40, out: grid, title: tag }))
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: childEnv(home, netlog, extraEnv),
    cwd: ROOT,
    timeout: vshotBudgetMs(150_000),
  })
  let gridText = ''
  const marks: Record<string, string> = {}
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    for (const m of payload.marks ?? []) marks[m.label] = text(m.grid)
    gridText = [...Object.values(marks), payload.grid ? text(payload.grid) : ''].join('\n')
  }
  return { status: res.status, gridText, marks, stderr: (res.stderr ?? '').trim() }
}
const seededHome = (name: string): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  return home
}

/** The boot to the composer, then /speak on — the shared opening. */
const OPENING: unknown[] = [
  // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session
  // enters the chat first.
  { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 60, data: '/speak on', awaitText: 'Type a prompt', minTick: 5 },
  { afterPrevTicks: 3, data: '\r' },
]

console.log('============================================================')
console.log(' voice input — the journey on the bundle, hermetic')
console.log('============================================================')

// ── §0 poison control: the tripwire trips ───────────────────────────────────
console.log('[0] poison control — the tripwire trips on a non-loopback fetch')
{
  const netlog = join(scratch, 'poison-net.log')
  let tripped = false
  try {
    execFileSync('node', ['-e', "fetch('http://203.0.113.9:80/v1/audio/transcriptions').then(() => process.exit(0), () => process.exit(3))"], { env: childEnv(join(scratch, 'poison-home'), netlog), timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    tripped = true
  }
  check('control: a poison-host fetch trips and logs', tripped && netlines(netlog).some(l => l.startsWith('fetch ')), netlines(netlog).join(' · '))
}

// ── §A the journey ──────────────────────────────────────────────────────────
console.log('[A] /speak → /speak on → v → v → the words land, cursor at the end → /speak off → v types')
{
  const netlog = join(scratch, 'journey-net.log')
  const fx = await startFixture('journey', 1500)
  const res = drive(
    'journey',
    seededHome('home-a'),
    netlog,
    [
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/speak', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'voice input OFF — /speak on turns it on', awaitStableTicks: 2, mark: 'status-off', data: '/speak on' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording', data: 'v' },
      { requireAwait: true, awaitText: 'transcribing…', mark: 'transcribing', data: '' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed', data: ' z' },
      { afterPrevTicks: 3, mark: 'typed-after', data: '\x15' },
      { afterPrevTicks: 3, data: '/speak off' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'voice input OFF — v is the letter v', awaitStableTicks: 2, mark: 'off', data: 'v' },
      { afterPrevTicks: 4, mark: 'letter', data: '' },
    ],
    160,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered every send (a real boot)', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('bare /speak reports OFF with the backend and the transcriber', (res.marks['status-off'] ?? '').includes('backend: fixture WAV') && (res.marks['status-off'] ?? '').includes('transcriber: OpenAI'), (res.marks['status-off'] ?? '').split('\n').filter(l => l.includes('backend') || l.includes('transcriber')).join(' · '))
  check('/speak on says ON and teaches the key', (res.marks.on ?? '').includes('voice input ON — press v in an empty composer'))
  check('v: the footer paints ● recording · v or esc to stop', (res.marks.recording ?? '').includes('● recording · v or esc to stop'))
  check('v again: the footer paints transcribing…', (res.marks.transcribing ?? '').includes('transcribing…'))
  check('the canned words land in the composer', (res.marks.landed ?? '').includes(TRANSCRIPT))
  check('the cursor sat at the END: a typed character lands after the words', (res.marks['typed-after'] ?? '').includes('lazy dog z'))
  check('the transcribing receipt names the family and the row', (res.marks['typed-after'] ?? res.marks.landed ?? '').includes('transcribed by OpenAI (gpt-4o-transcribe)'))
  check('/speak off says OFF', (res.marks.off ?? '').includes('voice input OFF — v is the letter v'))
  const letter = res.marks.letter ?? ''
  check('with voice input off, v is the letter v in the composer', /❯ v\b/.test(letter) && !letter.includes('recording ·'), letter.split('\n').filter(l => l.includes('❯')).join(' · '))
  const served = ledgerPosts(fx.ledger)
  check('the loopback transcriber served exactly ONE take (a multipart WAV, the first row)', served.length === 1 && served[0]!.includes('/audio/transcriptions') && served[0]!.includes('wav=yes') && served[0]!.includes('model=gpt-4o-transcribe'), served.join(' | '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §B a keyless home ───────────────────────────────────────────────────────
console.log('[B] a keyless home — v answers the no-transcriber receipt before any take')
{
  const netlog = join(scratch, 'keyless-net.log')
  const res = drive(
    'keyless',
    seededHome('home-b'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      // The needle is the notification's ONE-ROW spelling: the /speak
      // receipt above wraps the same words across two rows of its box.
      { requireAwait: true, awaitText: 'or /logins gemini', awaitStableTicks: 1, mark: 'receipt', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    90,
    {},
  )
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('the receipt names the doors in the neutral grammar', (res.marks.receipt ?? '').includes('no sign-in transcribes yet — /logins openai (API key) or /logins gemini'), (res.marks.receipt ?? '').split('\n').filter(l => l.includes('sign-in')).join(' · '))
  check('no take started (the footer never said recording)', !(res.marks.receipt ?? '').includes('recording ·'))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §C no backend ───────────────────────────────────────────────────────────
console.log('[C] no pack, no recorder — v answers the no-backend receipt')
{
  const netlog = join(scratch, 'nobackend-net.log')
  const res = drive(
    'nobackend',
    seededHome('home-c'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      // The notification's one-row spelling keeps the backticked command
      // whole; the /speak receipt's box wraps inside it.
      { requireAwait: true, awaitText: 'run `bun run setup` (needs cargo)', awaitStableTicks: 1, mark: 'receipt', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    90,
    {
      OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000',
      MERCURY_OPENAI_API_BASE: DEAD,
      MERCURY_VOICE_BACKEND: undefined,
      MERCURY_VOICE_PACK_DIR: EMPTY_PACK,
      PATH: `${shimDir}${delimiter}${nodeDir()}`,
    },
  )
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('the receipt names both remedies: the pack (bun run setup, cargo) and a PATH recorder', (res.marks.receipt ?? '').includes('no microphone backend') && (res.marks.receipt ?? '').includes('bun run setup'), (res.marks.receipt ?? '').split('\n').filter(l => l.includes('backend')).join(' · '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §D esc cancels — zero requests ─────────────────────────────────────────
console.log('[D] v then esc — the take is cancelled and NO request is made')
{
  const netlog = join(scratch, 'cancel-net.log')
  const fx = await startFixture('cancel', 0)
  const res = drive(
    'cancel',
    seededHome('home-d'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording', data: '\x1b' },
      { requireAwait: true, awaitText: 'capture cancelled — nothing sent', awaitStableTicks: 2, mark: 'cancelled', data: '' },
      { afterPrevTicks: 5, data: '' },
    ],
    100,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('the footer painted recording, then esc painted the cancel receipt', (res.marks.recording ?? '').includes('● recording') && (res.marks.cancelled ?? '').includes('capture cancelled — nothing sent') && !(res.marks.cancelled ?? '').includes('recording ·'))
  const served = ledgerPosts(fx.ledger)
  check('the transcriber saw ZERO requests', served.length === 0, served.join(' | '))
  const audio = netlines(netlog).filter(l => l.includes('/audio/') || l.includes(':generateContent'))
  check('no transcription request left the child at all (loopback included)', audio.length === 0, audio.join(' · '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

if (failures > 0) {
  // The grids stay for forensics: <scratch>/<leg>-grid.json carries every
  // mark's screen.
  console.log(`\nprove-voice-journey: RED (${failures}) — grids kept under ${scratch}`)
  process.exit(1)
}
rmSync(scratch, { recursive: true, force: true })
console.log('\nprove-voice-journey: green')
process.exit(0)
