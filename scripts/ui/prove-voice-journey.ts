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
//    §E the other family: a Gemini API key alone transcribes through the
//       generateContent wire (the WAV inline, the verbatim instruction).
//    §F the roads between the keys: /speak on twice is one receipt; v in a
//       NON-empty composer types the letter; a resize mid-capture keeps the
//       footer's recording line; two takes back to back both land; a quit
//       mid-capture exits cleanly.
//    §G the bound: with the proof seam at 1.5 s the take stops by itself,
//       the receipt names the bound, the words land — no key pressed.
//    §H the concourse: with voice input on, v on the Session Concourse is
//       nothing — no take, no crash, shift+← still walks home.
//    §I the composer's other keys with voice input on: ? opens help, the
//       ctrl+x p chord opens the palette, shift+← / → walk the strip, and
//       v still records after all of it.
//    §J the composer's overlays with voice input on, then off: the external
//       editor and the palette open and return — the session survives (a
//       hook below the overlay marker would end it: React error 300).
// ============================================================================
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { referenceFixtureSnapshot } from '../notifications/concourseReferenceSeed.ts'
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
    'MERCURY_VOICE_BOUND_MS',
    'MERCURY_OPENAI_API_BASE',
    'MERCURY_GEMINI_API_BASE',
    'MERCURY_CONCOURSE',
    'MERCURY_CONCOURSE_FIXTURE',
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
  /** Why the capture ended: 'eof' = the child exited. */
  endReason: string
}
interface DriveOptions {
  /** Mid-flight PTY resizes (the vshot `resizes` schedule). */
  resizes?: unknown[]
  /** The bundle's argv after `node dist/mercury.mjs` (default: the plain world). */
  args?: string[]
}
function drive(tag: string, home: string, netlog: string, sends: unknown[], total: number, extraEnv: Record<string, string | undefined>, opts: DriveOptions = {}): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  // The PLAIN WORLD (--chat): the Boot face and a chat with no Session
  // Concourse — a concourse boot hands the chat over to a daemon-hosted
  // session moments after New Session, and a command typed across that
  // handover lands in the session being replaced. The voice keys are the
  // composer's; the world they are proved in is the one without the race.
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: ['node', DIST, ...(opts.args ?? ['--chat'])], sends, ...(opts.resizes ? { resizes: opts.resizes } : {}), total, cols: 120, rows: 40, out: grid, title: tag }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: childEnv(home, netlog, extraEnv),
    cwd: ROOT,
    timeout: vshotBudgetMs(150_000),
  })
  let gridText = ''
  let endReason = ''
  const marks: Record<string, string> = {}
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
      endReason?: string
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    for (const m of payload.marks ?? []) marks[m.label] = text(m.grid)
    gridText = [...Object.values(marks), payload.grid ? text(payload.grid) : ''].join('\n')
    endReason = payload.endReason ?? ''
  }
  return { status: res.status, gridText, marks, stderr: (res.stderr ?? '').trim(), endReason }
}
const seededHome = (name: string): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  return home
}

// THE ADMISSION GATE: after ↵ New Session the chat paints its composer at
// once, but the switchboard admits the session moments later and the REPL
// re-initialises the draft at that admission — a command typed across it
// is dropped (the tag bar's stage-1 line "new session · <project> · ready"
// marks the admission). Every first keystroke waits for that line.
const ADMITTED = 'new session ·'

/** The boot to the composer, then /speak on — the shared opening. */
const OPENING: unknown[] = [
  // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session
  // enters the chat first.
  { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 110, data: '/speak on', awaitText: ADMITTED, minTick: 5, awaitStableTicks: 2 },
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
      { atTick: 110, data: '/speak', awaitText: ADMITTED, minTick: 5, awaitStableTicks: 2 },
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

// ── §E the other family: Gemini ────────────────────────────────────────────
console.log('[E] a Gemini API key alone — the take rides generateContent with the WAV inline')
{
  const netlog = join(scratch, 'gemini-net.log')
  const fx = await startFixture('gemini', 1500)
  const res = drive(
    'gemini',
    seededHome('home-e'),
    netlog,
    [
      // ↵ New Session once the Boot face's Model cell carries the row the
      // loopback catalogue answered (a Gemini-only home has no built-in
      // row; the chat refuses to start without one).
      { atTick: 70, awaitText: '2.5 Flash', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 140, data: '/speak on', awaitText: ADMITTED, minTick: 5, awaitStableTicks: 2 },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording', data: 'v' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    140,
    // The Gemini family's rows come from its catalogue wire alone, and the
    // essential-traffic posture refuses every catalogue fetch — so this leg
    // stands one rung down (telemetry off) and the catalogue GET reaches
    // the loopback. Whatever else that rung lets the boot attempt is
    // refused by the tripwire and censused below.
    { GOOGLE_API_KEY: 'fixture-gemini-key-000000', MERCURY_GEMINI_API_BASE: `http://127.0.0.1:${fx.port}/v1beta`, MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: undefined, DISABLE_TELEMETRY: '1' },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('/speak on names Gemini as the transcriber (the one signed-in family)', (res.marks.on ?? '').includes('transcriber: Gemini'), (res.marks.on ?? '').split('\n').filter(l => l.includes('transcriber')).join(' · '))
  check('the canned words land in the composer through Gemini', (res.marks.landed ?? '').includes(TRANSCRIPT) && (res.marks.landed ?? '').includes('transcribed by Gemini ('), (res.marks.landed ?? '').split('\n').filter(l => l.includes('transcribed') || l.includes('❯')).join(' · '))
  const served = ledgerPosts(fx.ledger)
  check('the loopback saw exactly ONE generateContent POST with the WAV inline and the verbatim instruction', served.length === 1 && served[0]!.includes(':generateContent') && served[0]!.includes('wav=yes') && served[0]!.includes('verbatim=yes'), served.join(' | '))
  const stray = nonLoopback(netlines(netlog))
  check('no voice wire left loopback (the take rode the loopback catalogue family only)', !stray.some(l => l.includes('/audio/') || l.includes(':generateContent')), stray.join(' · '))
  if (stray.length > 0) console.log(`  · the telemetry-off rung let the boot attempt ${stray.length} non-loopback request(s), every one refused by the tripwire: ${stray.slice(0, 4).join(' · ')}`)
}

// ── §F the roads between the keys ──────────────────────────────────────────
console.log('[F] /speak on twice · v in a non-empty composer · a resize mid-capture · two takes · a quit mid-capture')
{
  const netlog = join(scratch, 'roads-net.log')
  const fx = await startFixture('roads', 800)
  const res = drive(
    'roads',
    seededHome('home-f'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, data: '/speak on' },
      { afterPrevTicks: 3, data: '\r' },
      // A non-empty composer: the letter x, then v — v must type.
      { requireAwait: true, awaitText: 'voice input already on', awaitStableTicks: 2, mark: 'again', data: 'x' },
      { afterPrevTicks: 2, data: 'v' },
      { afterPrevTicks: 3, mark: 'typed-xv', data: '\x15' },
      // Take 1: the resize lands while recording (see `resizes` below).
      { afterPrevTicks: 2, data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording-1', data: '' },
      { afterPrevTicks: 8, mark: 'resized-recording', data: 'v' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed-1', data: '\x15' },
      // Take 2, back to back.
      { afterPrevTicks: 2, data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording-2', data: 'v' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed-2', data: '\x15' },
      // Take 3: quit while it records — the LAST sends; the child exits.
      { afterPrevTicks: 2, data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording-3', data: '/exit' },
      { afterPrevTicks: 3, data: '\r' },
    ],
    220,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
    { resizes: [{ afterMark: 'recording-1', afterMs: 500, cols: 110, rows: 36 }] },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered every send', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('/speak on again is one receipt: already on', (res.marks.again ?? '').includes('voice input already on'), (res.marks.again ?? '').split('\n').filter(l => l.includes('voice input')).join(' · '))
  const typed = res.marks['typed-xv'] ?? ''
  check('v in a NON-empty composer types the letter (no take)', /❯ xv\b/.test(typed) && !typed.includes('recording ·'), typed.split('\n').filter(l => l.includes('❯')).join(' · '))
  const resized = res.marks['resized-recording'] ?? ''
  const resizedCols = resized.split('\n')[0]?.length ?? 0
  check('a resize mid-capture keeps the footer recording line (the take survives)', resizedCols === 110 && resized.includes('● recording · v or esc to stop'), `${resizedCols} cols · ${resized.split('\n').filter(l => l.includes('recording')).join(' · ')}`)
  check('the first take lands after the resize', (res.marks['landed-1'] ?? '').includes(TRANSCRIPT))
  check('the second take, back to back, lands too', (res.marks['landed-2'] ?? '').includes(TRANSCRIPT) && (res.marks['recording-2'] ?? '').includes('● recording'))
  check('the third take was recording when /exit was typed', (res.marks['recording-3'] ?? '').includes('● recording'))
  const finalScreen = res.gridText.split('\n').slice(-40).join('\n')
  check('a quit mid-capture exits (the child ended) without a crash on screen', res.endReason === 'eof' && !/TypeError|ReferenceError|Unhandled|at .*\.mjs:\d+/.test(finalScreen), `ended: ${res.endReason}`)
  const served = ledgerPosts(fx.ledger)
  check('the loopback served exactly TWO takes — the quit take was dropped, never sent', served.length === 2 && served.every(l => l.includes('wav=yes')), served.join(' | '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §G the bound ───────────────────────────────────────────────────────────
console.log('[G] the bound — with the proof seam at 1.5 s the take stops by itself, named, and lands')
{
  const netlog = join(scratch, 'bound-net.log')
  const fx = await startFixture('bound', 2500)
  const res = drive(
    'bound',
    seededHome('home-g'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording', data: '' },
      // No key from here on: the owner stops the take at the bound.
      { requireAwait: true, awaitText: 'bound — transcribing', mark: 'bound', data: '' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 2, data: '' },
    ],
    120,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1`, MERCURY_VOICE_BOUND_MS: '1500' },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  // The receipt shares the footer's one notice row with the transient phase word, so the frame that carries the
  // receipt need not carry 'transcribing…' in the same beat; the footer's phase word is §A's pin.
  check('the bound receipt names the bound and says the take is transcribing', (res.marks.bound ?? '').includes('capture stopped at the 1.5-second bound — transcribing'), (res.marks.bound ?? '').split('\n').filter(l => l.includes('bound') || l.includes('transcribing')).join(' · '))
  check('the auto-stopped take lands in the composer', (res.marks.landed ?? '').includes(TRANSCRIPT) && (res.marks.landed ?? '').includes('transcribed by OpenAI'), (res.marks.landed ?? '').split('\n').filter(l => l.includes('❯') || l.includes('transcribed')).join(' · '))
  const served = ledgerPosts(fx.ledger)
  check('exactly ONE take reached the transcriber', served.length === 1, served.join(' | '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §H the concourse ───────────────────────────────────────────────────────
console.log('[H] voice input on, v on the Session Concourse — nothing; shift+← walks home')
{
  const netlog = join(scratch, 'concourse-net.log')
  const home = seededHome('home-h')
  // /speak on persisted BEFORE the boot: the seeded config gains the toggle.
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, voiceInputEnabled: true }, null, 2) + '\n')
  const fixture = referenceFixtureSnapshot() as { groups: Array<{ rows: Array<Record<string, unknown>> }> }
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = home
  const fixturePath = join(scratch, 'concourse-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  const res = drive(
    'concourse',
    home,
    netlog,
    [
      { atTick: 30, data: 'v' },
      { afterPrevTicks: 6, mark: 'after-v', data: '\x1b[1;2D' },
      { afterPrevTicks: 10, mark: 'home', data: '' },
    ],
    60,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: DEAD, MERCURY_CONCOURSE: 'always', MERCURY_CONCOURSE_FIXTURE: fixturePath, MERCURY_CREW_DIR: join(scratch, 'crew') },
    { args: [] },
  )
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  const afterV = res.marks['after-v'] ?? ''
  check('v on the concourse starts nothing (no recording line, no receipt, the board still painted)', !afterV.includes('recording ·') && !afterV.includes('transcrib') && afterV.includes('╭'), afterV.split('\n').slice(0, 3).join(' · '))
  check('shift+← walks home to the Boot face', (res.marks.home ?? '').includes('↑↓ choose'), (res.marks.home ?? '').split('\n').filter(l => l.includes('choose')).join(' · '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §I the composer's other keys, with voice input on ──────────────────────
console.log('[I] with voice input on: ? opens help · ctrl+x p opens the palette · shift+← / → walk the strip · v still records')
{
  const netlog = join(scratch, 'keys-net.log')
  const fx = await startFixture('keys', 0)
  const res = drive(
    'keys',
    seededHome('home-i'),
    netlog,
    [
      ...OPENING,
      // ? toggles the shortcuts panel; a second ? toggles it away.
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, data: '?' },
      { requireAwait: true, awaitText: '/keybindings to customize', awaitStableTicks: 1, mark: 'help', data: '?' },
      { afterPrevTicks: 4, mark: 'help-closed', data: '\x18' },
      { afterPrevTicks: 2, data: 'p' },
      { requireAwait: true, awaitText: 'fuzzy by name', awaitStableTicks: 1, mark: 'palette', data: '\x1b' },
      { afterPrevTicks: 4, mark: 'palette-closed', data: '\x1b[1;2D' },
      { requireAwait: true, awaitText: '↑↓ choose', awaitStableTicks: 2, mark: 'face', data: '\x1b[1;2C' },
      { requireAwait: true, awaitText: 'Type a prompt', awaitStableTicks: 2, mark: 'chat', data: 'v' },
      { requireAwait: true, awaitText: 'recording · v or esc to stop', awaitStableTicks: 1, mark: 'recording', data: '\x1b' },
      { requireAwait: true, awaitText: 'capture cancelled — nothing sent', awaitStableTicks: 1, mark: 'cancelled', data: '' },
      { afterPrevTicks: 2, data: '' },
    ],
    160,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered every send', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('? in the empty composer opens the shortcuts panel (untouched by the v filter); ? again closes it', (res.marks.help ?? '').includes('/keybindings to customize') && !(res.marks['help-closed'] ?? '').includes('/keybindings to customize'), `${(res.marks.help ?? '').includes('/keybindings') ? 'opened' : 'never opened'} · ${(res.marks['help-closed'] ?? '').includes('/keybindings') ? 'still open' : 'closed'}`)
  check('the ctrl+x p chord opens the command palette; esc closes it', (res.marks.palette ?? '').includes('fuzzy by name') && !(res.marks['palette-closed'] ?? '').includes('fuzzy by name'))
  check('shift+← walks to the Boot face and shift+→ returns to the chat', (res.marks.face ?? '').includes('↑↓ choose') && (res.marks.chat ?? '').includes('Type a prompt'))
  check('after all that, v still records and esc still cancels', (res.marks.recording ?? '').includes('● recording') && (res.marks.cancelled ?? '').includes('capture cancelled — nothing sent'))
  check('no take was sent', ledgerPosts(fx.ledger).length === 0)
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

// ── §J the composer's overlays with voice input on AND off ─────────────────
// The regression class the voice key must never reintroduce: a hook
// declared below the composer's overlay marker is skipped by an overlay's
// early return, and React ends the session (error 300) the moment one
// opens. The external editor (a shim that appends a word to the draft file)
// and the command palette open and return with the toggle on, then off.
console.log('[J] the overlays with voice input on, then off — the external editor and the palette open and return')
{
  const netlog = join(scratch, 'overlays-net.log')
  const fx = await startFixture('overlays', 0)
  const editShim = join(shimDir, 'edit-shim')
  writeFileSync(editShim, `#!/bin/sh\nprintf ' edited' >> "$1"\n`)
  chmodSync(editShim, 0o755)
  const res = drive(
    'overlays',
    seededHome('home-j'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, data: 'hello' },
      { afterPrevTicks: 2, data: '\x18' },
      { afterPrevTicks: 2, data: '\x05' },
      { requireAwait: true, awaitText: 'hello edited', awaitStableTicks: 2, mark: 'editor-on', data: '\x18' },
      { afterPrevTicks: 2, data: 'p' },
      { requireAwait: true, awaitText: 'fuzzy by name', awaitStableTicks: 1, mark: 'palette-on', data: '\x1b' },
      { afterPrevTicks: 3, data: '\x15' },
      { afterPrevTicks: 2, data: '/speak off' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'voice input OFF', awaitStableTicks: 2, data: 'again' },
      { afterPrevTicks: 2, data: '\x18' },
      { afterPrevTicks: 2, data: '\x05' },
      { requireAwait: true, awaitText: 'again edited', awaitStableTicks: 2, mark: 'editor-off', data: '\x18' },
      { afterPrevTicks: 2, data: 'p' },
      { requireAwait: true, awaitText: 'fuzzy by name', awaitStableTicks: 1, mark: 'palette-off', data: '\x1b' },
      { afterPrevTicks: 3, mark: 'end', data: '' },
    ],
    180,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1`, VISUAL: editShim, EDITOR: editShim },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered every send', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('voice ON: the external editor opened, returned, and the edit landed in the composer', /❯ hello edited/.test(res.marks['editor-on'] ?? ''), (res.marks['editor-on'] ?? '').split('\n').filter(l => l.includes('❯')).join(' · '))
  check('voice ON: the command palette opened', (res.marks['palette-on'] ?? '').includes('fuzzy by name'))
  check('voice OFF: the external editor opened, returned, and the edit landed', /❯ again edited/.test(res.marks['editor-off'] ?? ''), (res.marks['editor-off'] ?? '').split('\n').filter(l => l.includes('❯')).join(' · '))
  check('voice OFF: the command palette opened', (res.marks['palette-off'] ?? '').includes('fuzzy by name'))
  check('the session survived every overlay (the child never exited; no crash on screen)', res.endReason !== 'eof' && !res.gridText.includes('Mercury exited on an error') && (res.marks.end ?? '').includes('❯'), `ended: ${res.endReason}`)
  check('no take was sent', ledgerPosts(fx.ledger).length === 0)
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
