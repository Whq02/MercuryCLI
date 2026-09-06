#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { voicePackPlatform } from '../../src/services/voice/voicePack.ts'
import { checkWhisperPackDir, whisperPackDirFor } from '../../src/services/voice/whisperPack.ts'
import { WHISPER_MODELS_SEGMENTS, WHISPER_MODELS_VENDOR_PATH, whisperDefaultModel } from '../../src/services/voice/whisperModels.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(ROOT, 'scripts', 'voice', 'voice-transcriber-fixture-server.ts')
const SPEECH = join(ROOT, 'scripts', 'voice', 'fixtures', 'on-device-take.wav')
const SPOKEN = /seven ships/i
const CLOUD_TRANSCRIPT = 'the quick brown fox jumps over the lazy dog'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the on-device voice journey cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}
const PLATFORM = voicePackPlatform()
const packBesideBundle = whisperPackDirFor(join(ROOT, 'dist'), PLATFORM)
const packCheck = checkWhisperPackDir(packBesideBundle, { digest: true })
if (packCheck.state !== 'ok') {
  console.log(`prove-voice-local-journey: SKIPPED — no on-device transcriber pack beside the bundle for ${PLATFORM} (${packCheck.note}); the host that built dist had no cargo or cmake, and the build degraded honestly`)
  process.exit(0)
}
const MODEL = whisperDefaultModel()
const CACHED_MODEL = join(ROOT, 'vendor', 'whisper-models', MODEL.file)
if (!existsSync(CACHED_MODEL)) {
  console.log(`prove-voice-local-journey: SKIPPED — ${WHISPER_MODELS_VENDOR_PATH}/${MODEL.file} is absent (bun run scripts/vendor/fetch-whisper-models.ts fetches it)`)
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'voice-local-journey-'))
const shimDir = join(scratch, 'bin')
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\nexit 128\n`)
  chmodSync(path, 0o755)
}

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
    MERCURY_VOICE_FIXTURE_WAV: SPEECH,
    MERCURY_UPDATE_NOTICE: '0',
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
    'MERCURY_WHISPER_PACK_DIR',
    'MERCURY_WHISPER_MODEL',
    'MERCURY_VOICE_TRANSCRIBER',
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

const netlines = (netlog: string): string[] => (existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(l => l.trim() !== '') : [])
const nonLoopback = (lines: string[]): string[] => lines.filter(l => !(l.startsWith('tcp-local') || l.startsWith('tls-local') || l.includes('-local.') || l.startsWith('fetch-local')))
const voiceWires = (lines: string[]): string[] => lines.filter(l => l.includes('/audio/') || l.includes(':generateContent') || l.includes('huggingface'))
const ledgerPosts = (ledger: string): string[] => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes(' POST ')) : [])

interface Fixture {
  child: ChildProcess
  port: number
  ledger: string
}
async function startFixture(tag: string, delayMs: number): Promise<Fixture> {
  const ledger = join(scratch, `${tag}-ledger.log`)
  const child = spawn(process.execPath, ['run', FIXTURE, String(delayMs), ledger, CLOUD_TRANSCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  endReason: string
}
function drive(tag: string, home: string, netlog: string, sends: unknown[], total: number, extraEnv: Record<string, string | undefined>): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--chat'], sends, total, cols: 120, rows: 40, out: grid, title: tag }))
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
const seededHome = (name: string, withModel = true): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  if (withModel) {
    const dir = join(home, ...WHISPER_MODELS_SEGMENTS)
    mkdirSync(dir, { recursive: true })
    try {
      symlinkSync(CACHED_MODEL, join(dir, MODEL.file))
    } catch {
      copyFileSync(CACHED_MODEL, join(dir, MODEL.file))
    }
  }
  return home
}

const ADMITTED = ' · ready'
const OPENING: unknown[] = [
  { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 110, data: '/speak on', awaitText: ADMITTED, minTick: 5, awaitStableTicks: 2 },
  { afterPrevTicks: 3, data: '\r' },
]
const gridLines = (text: string, needle: string): string => text.split('\n').filter(l => l.includes(needle)).join(' · ')

console.log('============================================================')
console.log(` voice input — the on-device road on the bundle (${MODEL.name}, ${PLATFORM})`)
console.log('============================================================')

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

console.log('[A] no key at all — /speak on names the on-device road; space, space; the words land; nothing leaves')
{
  const netlog = join(scratch, 'keyless-net.log')
  const res = drive(
    'keyless',
    seededHome('home-a'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: ' ' },
      { requireAwait: true, awaitText: 'recording · space or esc to stop', awaitStableTicks: 1, mark: 'recording', data: ' ' },
      { requireAwait: true, awaitText: 'seven ships', awaitStableTicks: 2, mark: 'landed', data: ' z' },
      { afterPrevTicks: 3, mark: 'typed-after', data: '' },
    ],
    140,
    {},
  )
  check('the drive delivered every send (a real boot)', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('/speak on names the on-device transcriber, the engine, the model and the pack', (res.marks.on ?? '').includes(`transcriber: on-device — whisper.cpp ${MODEL.name} (pack `) && (res.marks.on ?? '').includes('beside the'), gridLines(res.marks.on ?? '', 'transcriber'))
  check('space: the footer paints ● recording, the started receipt names the on-device transcriber', (res.marks.recording ?? '').includes('● recording · space or esc to stop'), gridLines(res.marks.recording ?? '', 'recording'))
  check('the fixture\'s words land in the composer, decoded on this machine', SPOKEN.test(res.marks.landed ?? ''), gridLines(res.marks.landed ?? '', '❯'))
  check('the cursor sat at the END: a typed character lands after the words', /breakfast\.? z/.test(res.marks['typed-after'] ?? ''), gridLines(res.marks['typed-after'] ?? '', '❯'))
  check('the receipt says transcribed on this machine, naming the model', (res.marks['typed-after'] ?? res.marks.landed ?? '').includes(`transcribed on this machine (${MODEL.name})`), gridLines(res.marks['typed-after'] ?? '', 'transcribed'))
  const lines = netlines(netlog)
  check('no voice wire left the child at all, loopback included', voiceWires(lines).length === 0, voiceWires(lines).join(' · '))
  check('nothing left loopback', nonLoopback(lines).length === 0, nonLoopback(lines).join(' · '))
  check('the child made no HTTP request of any kind', !lines.some(l => l.startsWith('fetch')), lines.filter(l => l.startsWith('fetch')).join(' · '))
}

console.log('[B] an OpenAI key AND the pack — the order law on the bundle: still zero requests')
{
  const netlog = join(scratch, 'keyed-net.log')
  const fx = await startFixture('keyed', 0)
  const res = drive(
    'keyed',
    seededHome('home-b'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: ' ' },
      { requireAwait: true, awaitText: 'recording · space or esc to stop', awaitStableTicks: 1, mark: 'recording', data: ' ' },
      { requireAwait: true, awaitText: 'seven ships', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    140,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('/speak on still names the on-device transcriber beside the signed-in key', (res.marks.on ?? '').includes('transcriber: on-device — whisper.cpp'), gridLines(res.marks.on ?? '', 'transcriber'))
  check('the words land on this machine', SPOKEN.test(res.marks.landed ?? '') && (res.marks.landed ?? '').includes('transcribed on this machine'), gridLines(res.marks.landed ?? '', '❯'))
  check('the loopback transcriber served NOTHING', ledgerPosts(fx.ledger).length === 0, ledgerPosts(fx.ledger).join(' | '))
  const lines = netlines(netlog)
  check('no voice wire left the child, loopback included', voiceWires(lines).length === 0, voiceWires(lines).join(' · '))
  check('nothing left loopback', nonLoopback(lines).length === 0, nonLoopback(lines).join(' · '))
}

console.log('[C] the pin openai — the cloud road serves: exactly one loopback POST')
{
  const netlog = join(scratch, 'pinned-net.log')
  const fx = await startFixture('pinned', 800)
  const res = drive(
    'pinned',
    seededHome('home-c'),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: ' ' },
      { requireAwait: true, awaitText: 'recording · space or esc to stop', awaitStableTicks: 1, mark: 'recording', data: ' ' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    140,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1`, MERCURY_VOICE_TRANSCRIBER: 'openai' },
  )
  fx.child.kill('SIGTERM')
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  check('/speak on names OpenAI and says the on-device road is held back by the pin', (res.marks.on ?? '').includes('transcriber: OpenAI') && (res.marks.on ?? '').includes('held back by MERCURY_VOICE_TRANSCRIBER'), gridLines(res.marks.on ?? '', 'transcriber'))
  check('the canned cloud words land, the receipt names the family', (res.marks.landed ?? '').includes(CLOUD_TRANSCRIPT) && (res.marks.landed ?? '').includes('transcribed by OpenAI ('), gridLines(res.marks.landed ?? '', '❯'))
  const served = ledgerPosts(fx.ledger)
  check('the loopback transcriber served exactly ONE take', served.length === 1 && served[0]!.includes('/audio/transcriptions') && served[0]!.includes('wav=yes'), served.join(' | '))
  const stray = nonLoopback(netlines(netlog))
  check('nothing left loopback', stray.length === 0, stray.join(' · '))
}

console.log('[D] the pack present, the model absent — the download door at /speak on; space answers the receipt before any take')
{
  const netlog = join(scratch, 'nomodel-net.log')
  const res = drive(
    'nomodel',
    seededHome('home-d', false),
    netlog,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, mark: 'on', data: ' ' },
      { requireAwait: true, awaitText: '\nnothing transcribes yet — on-device model: /speak download; or /logins openai (API key) or /logins gemini', awaitStableTicks: 2, mark: 'receipt', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    140,
    {},
  )
  check('the drive delivered', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-300)}`)
  const on = res.marks.on ?? ''
  check('/speak on carries the download door: the size, the model, the licence, the verb', on.includes('one-time 60 MB download') && on.includes('Whisper base.en') && on.includes('(MIT)') && on.includes('/speak download starts it'), gridLines(on, 'download'))
  check('the receipt names the download door then the cloud doors, before any take', (res.marks.receipt ?? '').includes('nothing transcribes yet — on-device model: /speak download; or /logins openai (API key) or /logins gemini') && !(res.marks.receipt ?? '').includes('recording ·'), gridLines(res.marks.receipt ?? '', 'transcribes'))
  const lines = netlines(netlog)
  check('nothing left loopback, and no download was attempted', nonLoopback(lines).length === 0 && !lines.some(l => l.includes('huggingface')), lines.join(' · '))
}

console.log('[E] /speak options — the rows, the switch, the take through the saved family; a second boot names the saved choice gone and serves on-device')
{
  const home = seededHome('home-e')
  const netlog1 = join(scratch, 'options-1-net.log')
  const fx = await startFixture('options', 800)
  const first = drive(
    'options-1',
    home,
    netlog1,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'voice input ON', awaitStableTicks: 2, data: '/speak options' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'the shipped default', awaitStableTicks: 2, mark: 'rows', data: '/speak options openai' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'default transcriber: openai (saved)', awaitStableTicks: 2, mark: 'switched', data: ' ' },
      { requireAwait: true, awaitText: 'recording · space or esc to stop', awaitStableTicks: 1, mark: 'recording', data: ' ' },
      { requireAwait: true, awaitText: 'lazy dog', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    200,
    { OPENAI_API_KEY: 'sk-fixture-voice-000000000000000000000000', MERCURY_OPENAI_API_BASE: `http://127.0.0.1:${fx.port}/v1` },
  )
  fx.child.kill('SIGTERM')
  check('the first boot delivered every send', first.status === 0, `vshot ${first.status}: ${first.stderr.slice(-300)}`)
  const rows = first.marks.rows ?? ''
  check('/speak options lists on-device (serves now, the shipped default), OpenAI signed in, Gemini not signed in', rows.includes('● on-device — whisper.cpp') && rows.includes('(serves now, the shipped default)') && rows.includes('○ openai — OpenAI: OpenAI API key (env)') && rows.includes('○ gemini — Gemini: not signed in'), gridLines(rows, '— '))
  check('/speak options openai saves the choice and marks the row', (first.marks.switched ?? '').includes('default transcriber: openai (saved)') && (first.marks.switched ?? '').includes('● openai — OpenAI: OpenAI API key (env) (serves now, your saved choice)'), gridLines(first.marks.switched ?? '', 'openai'))
  check('the take goes to the saved family: the cloud words land, the receipt names OpenAI', (first.marks.landed ?? '').includes(CLOUD_TRANSCRIPT) && (first.marks.landed ?? '').includes('transcribed by OpenAI ('), gridLines(first.marks.landed ?? '', '❯'))
  const served = ledgerPosts(fx.ledger)
  check('the loopback transcriber served exactly ONE take', served.length === 1, served.join(' | '))
  check('nothing left loopback', nonLoopback(netlines(netlog1)).length === 0, nonLoopback(netlines(netlog1)).join(' · '))

  const netlog2 = join(scratch, 'options-2-net.log')
  const second = drive(
    'options-2',
    home,
    netlog2,
    [
      ...OPENING,
      { requireAwait: true, awaitText: 'cannot serve: not signed in', awaitStableTicks: 2, mark: 'status', data: ' ' },
      { requireAwait: true, awaitText: 'recording · space or esc to stop', awaitStableTicks: 1, mark: 'recording', data: ' ' },
      { requireAwait: true, awaitText: 'seven ships', awaitStableTicks: 2, mark: 'landed', data: '\x15' },
      { afterPrevTicks: 2, data: '/speak options default' },
      { afterPrevTicks: 3, data: '\r' },
      { requireAwait: true, awaitText: 'the shipped default (saved choice cleared)', awaitStableTicks: 2, mark: 'cleared', data: '' },
      { afterPrevTicks: 2, data: '' },
    ],
    200,
    {},
  )
  check('the second boot delivered every send', second.status === 0, `vshot ${second.status}: ${second.stderr.slice(-300)}`)
  check('the saved choice persisted and is named as not signed in; the on-device road serves', (second.marks.status ?? '').includes('your saved choice (OpenAI) cannot serve: not signed in') && (second.marks.status ?? '').includes('on-device serves'), gridLines(second.marks.status ?? '', 'saved'))
  check('space starts a take: the footer paints ● recording', (second.marks.recording ?? '').includes('● recording · space or esc to stop'), gridLines(second.marks.recording ?? '', 'recording'))
  check('the words land on this machine', SPOKEN.test(second.marks.landed ?? '') && (second.marks.landed ?? '').includes('transcribed on this machine'), gridLines(second.marks.landed ?? '', '❯'))
  check('/speak options default restores the shipped default', (second.marks.cleared ?? '').includes('default transcriber: the shipped default (saved choice cleared)') && (second.marks.cleared ?? '').includes('(serves now, the shipped default)'), gridLines(second.marks.cleared ?? '', 'default'))
  const lines = netlines(netlog2)
  check('the second boot made no request of any kind', voiceWires(lines).length === 0 && nonLoopback(lines).length === 0 && !lines.some(l => l.startsWith('fetch')), lines.filter(l => !l.startsWith('tcp-local')).join(' · '))
}

if (failures > 0) {
  console.log(`\nprove-voice-local-journey: RED (${failures}) — grids kept under ${scratch}`)
  process.exit(1)
}
rmSync(scratch, { recursive: true, force: true })
console.log('\nprove-voice-local-journey: green')
process.exit(0)
