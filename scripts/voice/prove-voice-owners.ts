#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const FIXTURE = join(import.meta.dir, 'voice-transcriber-fixture-server.ts')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'voice-owners-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.NODE_ENV = 'test'
for (const key of [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_VOICE_BACKEND',
  'MERCURY_VOICE_FIXTURE_WAV',
  'MERCURY_VOICE_DEBUG_WAV_DIR',
  'MERCURY_VOICE_PACK_DIR',
  'MERCURY_WHISPER_PACK_DIR',
  'MERCURY_WHISPER_MODEL',
  'MERCURY_VOICE_TRANSCRIBER',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_HOME',
]) {
  delete process.env[key]
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 300) : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const wav = await import('../../src/services/voice/wav.js')
const capture = await import('../../src/services/voice/capture.js')
const transcribe = await import('../../src/services/voice/transcribe.js')
const session = await import('../../src/services/voice/voiceSession.js')
const pendingInput = await import('../../src/input-core/pending-input.js')

const TONE = join(SCRATCH, 'tone.wav')
writeFileSync(TONE, wav.synthesizeToneWav({ seconds: 1, hz: 440 }))
const SILENT = join(SCRATCH, 'silent.wav')
writeFileSync(SILENT, wav.encodeWav(new Int16Array(wav.VOICE_SAMPLE_RATE)))
const EMPTY_PACK = join(SCRATCH, 'no-pack')
mkdirSync(EMPTY_PACK, { recursive: true })
const EMPTY_BIN = join(SCRATCH, 'empty-bin')
mkdirSync(EMPTY_BIN, { recursive: true })
const noTools = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: EMPTY_BIN })
const SPEECH = join(import.meta.dir, 'fixtures', 'on-device-take.wav')
const whisperModels = await import('../../src/services/voice/whisperModels.js')
const whisperPack = await import('../../src/services/voice/whisperPack.js')
const ON_DEVICE_MODEL = 'tiny.en-q5_1'
function seedOnDeviceModel(): string | null {
  const row = whisperModels.whisperModelByName(ON_DEVICE_MODEL)
  if (row === null) return `the catalogue has no ${ON_DEVICE_MODEL}`
  const cached = join(ROOT, 'vendor', 'whisper-models', row.file)
  if (!existsSync(cached)) return `${whisperModels.WHISPER_MODELS_VENDOR_PATH}/${row.file} is absent (bun run scripts/vendor/fetch-whisper-models.ts fetches it)`
  if (whisperPack.resolveWhisperPackDir().state !== 'ok') return 'the on-device pack is not built on this host (cargo and cmake)'
  const dir = whisperModels.whisperModelsDir(HOME)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, row.file))) {
    try {
      symlinkSync(cached, join(dir, row.file))
    } catch {
      copyFileSync(cached, join(dir, row.file))
    }
  }
  return null
}

interface Fixture {
  child: ChildProcess
  port: number
  ledger: string
  lines: () => string[]
  stop: () => void
}
async function startFixture(tag: string, opts: { delayMs?: number; transcript?: string; refuse?: string } = {}): Promise<Fixture> {
  const ledger = join(SCRATCH, `${tag}-ledger.log`)
  const child = spawn(process.execPath, ['run', FIXTURE, String(opts.delayMs ?? 0), ledger, opts.transcript ?? 'the quick brown fox jumps over the lazy dog', opts.refuse ?? ''], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
  return {
    child,
    port,
    ledger,
    lines: () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.trim() !== '') : []),
    stop: () => child.kill('SIGTERM'),
  }
}
const posts = (lines: string[]): string[] => lines.filter(l => l.includes(' POST '))

section('§1 the audio shape — one WAV owner')
{
  const pcm = new Int16Array(wav.VOICE_SAMPLE_RATE)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? 1000 : -1000
  const encoded = wav.encodeWav(pcm)
  check('a one-second take is 44 header bytes + 32000 sample bytes', encoded.length === 44 + 32_000, String(encoded.length))
  const read = wav.readWav(encoded)
  check('the WAV reads back with the capture shape', read.ok && wav.isVoiceWavShape(read.header) && read.header.dataBytes === 32_000, read.ok ? JSON.stringify(read.header) : read.reason)
  const streamed = Buffer.from(encoded)
  streamed.writeUInt32LE(0xffffffff, 40)
  const clamped = wav.readWav(streamed)
  check('a streamed-length data chunk clamps to the bytes present', clamped.ok && clamped.header.dataBytes === 32_000, clamped.ok ? String(clamped.header.dataBytes) : clamped.reason)
  check('a non-WAV refuses with its reason', !wav.readWav(Buffer.alloc(100, 7)).ok)
  const tone = wav.readWav(readFileSync(TONE))
  check('silence is silence; a tone is not', wav.pcmIsSilent(new Int16Array(1600)) && tone.ok && !wav.pcmIsSilent(tone.pcm))
  check('the duration reads from the sample count', wav.pcmDurationMs(pcm) === 1000)
}

section('§2 ONE capture owner — the ladder, the fixture, the bound, the cancel, no disk')
{
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  let r = capture.resolveCaptureBackend(noTools())
  check('fixture pinned without a WAV names MERCURY_VOICE_FIXTURE_WAV', r.state === 'none' && r.note.includes('MERCURY_VOICE_FIXTURE_WAV'), r.state === 'none' ? r.note : r.detail)
  process.env.MERCURY_VOICE_FIXTURE_WAV = TONE
  r = capture.resolveCaptureBackend(noTools())
  check('fixture pinned with a WAV resolves the fixture backend', r.state === 'ok' && r.kind === 'fixture' && r.pinned, r.state === 'none' ? r.note : r.detail)
  process.env.MERCURY_VOICE_BACKEND = 'bogus'
  r = capture.resolveCaptureBackend(noTools())
  check('an unknown pin names the backend vocabulary', r.state === 'none' && r.note.includes('vendored') && r.note.includes('ffmpeg'), r.state === 'none' ? r.note : r.detail)
  process.env.MERCURY_VOICE_BACKEND = 'sox'
  r = capture.resolveCaptureBackend(noTools())
  check('a pinned recorder absent from PATH names itself (no silent fallback)', r.state === 'none' && r.note.startsWith('MERCURY_VOICE_BACKEND=sox') && r.note.includes('not on PATH'), r.state === 'none' ? r.note : r.detail)
  delete process.env.MERCURY_VOICE_BACKEND
  process.env.MERCURY_VOICE_PACK_DIR = EMPTY_PACK
  r = capture.resolveCaptureBackend(noTools())
  check('no pack, no recorder ⇒ the no-backend receipt, every rung named', r.state === 'none' && r.note.startsWith(capture.NO_BACKEND_RECEIPT) && r.note.includes('MERCURY_VOICE_PACK_DIR') && r.tried.join(',') === 'vendored,sox,arecord,ffmpeg', r.state === 'none' ? r.note : r.detail)
  delete process.env.MERCURY_VOICE_PACK_DIR
  check('a checkout ⇒ the setup line', capture.noBackendReceipt('/somewhere/checkout') === capture.NO_BACKEND_RECEIPT)
  check('a release install ⇒ the recorder road with the platform\'s install command, never `bun run setup`', capture.noBackendReceipt(null, 'darwin') === `${capture.NO_BACKEND_RECEIPT_RELEASE} (brew install ffmpeg)` && !capture.noBackendReceipt(null, 'win32').includes('bun run setup') && capture.noBackendReceipt(null, 'win32').includes('winget install ffmpeg') && capture.noBackendReceipt(null, 'linux').includes('apt install ffmpeg'))
  const pack = await import('../../src/services/voice/voicePack.js')
  check('this checkout resolves (the proof runs from one), so the live receipt is the setup line', pack.voiceCheckoutRoot() !== null && capture.noBackendReceipt() === capture.NO_BACKEND_RECEIPT)
  check('the bound is five minutes', capture.CAPTURE_BOUND_MS === 300_000)
  process.env.MERCURY_VOICE_BOUND_MS = '80'
  check('the bound seam shortens the bound for a proof', capture.captureBoundMs() === 80, String(capture.captureBoundMs()))
  process.env.MERCURY_VOICE_BOUND_MS = String(capture.CAPTURE_BOUND_MS + 1)
  check('…never lengthens it: above the product bound ⇒ the product bound', capture.captureBoundMs() === capture.CAPTURE_BOUND_MS)
  process.env.MERCURY_VOICE_BOUND_MS = 'soon'
  check('…and a value that is not milliseconds ⇒ the product bound', capture.captureBoundMs() === capture.CAPTURE_BOUND_MS)
  delete process.env.MERCURY_VOICE_BOUND_MS
  check(
    'the bound label: whole minutes as minutes, a proof bound as seconds',
    session.boundLabel(capture.CAPTURE_BOUND_MS) === '5-minute' && session.boundLabel(1500) === '1.5-second' && session.boundLabel(120_000) === '2-minute',
    `${session.boundLabel(capture.CAPTURE_BOUND_MS)} · ${session.boundLabel(1500)} · ${session.boundLabel(120_000)}`,
  )

  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  const dump = join(SCRATCH, 'dump')
  const handle = await capture.startCapture({ env: noTools() })
  check('the fixture take opens on the fixture backend', handle.backend === 'fixture' && !handle.settled)
  const take = await handle.stop()
  const read = wav.readWav(take.wav)
  check('the take is a capture-shaped WAV of one second, not silent', read.ok && wav.isVoiceWavShape(read.header) && take.durationMs === 1000 && !take.silent && !take.autoStopped, read.ok ? `${take.durationMs}ms silent=${take.silent}` : read.reason)
  check('stop is idempotent', (await handle.stop()) === take)
  check('no take touched disk without the debug seam', !existsSync(dump))

  process.env.MERCURY_VOICE_FIXTURE_WAV = SILENT
  const silent = await (await capture.startCapture({ env: noTools() })).stop()
  check('a take of zeros is reported silent', silent.silent && silent.durationMs === 1000)
  process.env.MERCURY_VOICE_FIXTURE_WAV = TONE

  let autoStops = 0
  const bounded = await capture.startCapture({ env: noTools(), boundMs: 60, onAutoStop: () => autoStops++ })
  await sleep(200)
  check('the owner fires the auto-stop at the bound, once', autoStops === 1, String(autoStops))
  const boundedTake = await bounded.stop()
  check('the bounded take says it was auto-stopped', boundedTake.autoStopped)
  process.env.MERCURY_VOICE_BOUND_MS = '60'
  let seamStops = 0
  const seamBounded = await capture.startCapture({ env: noTools(), onAutoStop: () => seamStops++ })
  await sleep(200)
  delete process.env.MERCURY_VOICE_BOUND_MS
  check('a take opened without an explicit bound reads the seam', seamStops === 1 && (await seamBounded.stop()).autoStopped, String(seamStops))

  const cancelled = await capture.startCapture({ env: noTools() })
  cancelled.cancel()
  let refused = ''
  try {
    await cancelled.stop()
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check('a cancelled take answers nothing (stop refuses, named)', cancelled.settled && refused.includes('cancelled'), refused)

  process.env.MERCURY_VOICE_DEBUG_WAV_DIR = dump
  await (await capture.startCapture({ env: noTools() })).stop()
  const dumped = existsSync(dump) ? readdirSync(dump).filter(f => /^capture-\d+\.wav$/.test(f)) : []
  check('the debug seam writes exactly one capture-<epoch>.wav', dumped.length === 1, dumped.join(','))
  delete process.env.MERCURY_VOICE_DEBUG_WAV_DIR

  const src = join(ROOT, 'src')
  const filesWith = (needle: string): string[] => {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name)
        if (name.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name.name) && readFileSync(p, 'utf8').includes(needle)) out.push(p.slice(ROOT.length + 1))
      }
    }
    walk(src)
    return out
  }
  check('ONE capture owner spawns the PATH recorders', filesWith("'signed-integer'").join(',') === 'src/services/voice/capture.ts', filesWith("'signed-integer'").join(','))
  check('ONE transcriber owner speaks the speech-to-text wires', filesWith('audio/transcriptions').join(',') === 'src/services/voice/transcribe.ts', filesWith('audio/transcriptions').join(','))
}

section("§3 ONE transcriber owner — the order law, the ledger's order, the API-key slots, the pin, the doors")
{
  type Local = import('../../src/services/voice/transcribe.js').LocalTranscriberRead
  const NO_PACK: Local = { state: 'absent', reason: 'pack', note: 'absent on this checkout — bun run scripts/vendor/build-whisper.ts builds it (cargo and cmake)', short: 'no on-device pack (bun run setup)' }
  const ON_DEVICE: Local = { state: 'ok', label: 'on-device transcriber (base.en-q5_1)', model: 'base.en-q5_1', language: 'en', pack: { version: '0.1.0', platform: 'fixture-os-fixture-arch', engine: 'whisper.cpp 1.8.3', gpu: 'none', where: 'the checkout', floor: 'fixture-arch — met by the architecture' } }
  const reads = (openai: string | null, gemini: string | null, local: Local = NO_PACK): import('../../src/services/voice/transcribe.js').TranscriberReads => ({
    openaiApiKeyLabel: () => openai,
    geminiApiKeyLabel: () => gemini,
    localTranscriber: () => local,
  })
  let r = transcribe.pickTranscriber(['anthropic', 'openai', 'gemini'], reads('OpenAI API key (stored)', 'Gemini API key (stored)'))
  check('without the on-device road, the most recent transcribing sign-in wins (OpenAI before Gemini here)', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'openai' && r.choice.slot === 'api-key', JSON.stringify(r))
  check('Anthropic is passed over by name: no speech-to-text endpoint', r.skipped.some(s => s.startsWith('Anthropic') && s.includes('no speech-to-text endpoint')), r.skipped.join(' | '))
  r = transcribe.pickTranscriber(['gemini', 'openai'], reads('OpenAI API key (stored)', 'Gemini API key (stored)'))
  check("the order is the ledger's, never a fixed provider order (Gemini first here)", r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'gemini', JSON.stringify(r))
  r = transcribe.pickTranscriber(['openai', 'gemini'], reads(null, 'Gemini API key (env-gemini)'))
  check('an OpenAI sign-in without an API key (the subscription slot) is passed over by name', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'gemini' && r.skipped.some(s => s.startsWith('OpenAI') && s.includes('without an API key')), JSON.stringify(r))
  r = transcribe.pickTranscriber(['openai', 'anthropic'], reads(null, null))
  check('no transcribing sign-in and no on-device road ⇒ the doors, in the neutral grammar', r.state === 'none' && r.note === transcribe.noTranscriberReceipt(NO_PACK) && r.note === 'nothing transcribes yet — no on-device pack (bun run setup); or /logins openai (API key) or /logins gemini', JSON.stringify(r))
  r = transcribe.pickTranscriber([], reads('x', 'y'))
  check('a home with no sign-in at all ⇒ the same doors', r.state === 'none' && r.note === transcribe.noTranscriberReceipt(NO_PACK))
  check('the order that ships is on-device first', transcribe.TRANSCRIBER_ORDER === 'on-device-first')
  r = transcribe.pickTranscriber(['anthropic', 'openai', 'gemini'], reads('OpenAI API key (stored)', 'Gemini API key (stored)', ON_DEVICE))
  check('the on-device road present wins over every signed-in family', r.state === 'ok' && r.choice.kind === 'local' && r.choice.model === 'base.en-q5_1', JSON.stringify(r))
  check('…the families with a key are listed as not used, with the pin that would choose each', r.state === 'ok' && r.unused.length === 2 && r.unused.every(u => /MERCURY_VOICE_TRANSCRIBER=(openai|gemini) chooses it$/.test(u)), r.state === 'ok' ? r.unused.join(' | ') : r.note)
  r = transcribe.pickTranscriber([], reads(null, null, ON_DEVICE))
  check('keyless + on-device ⇒ ok: voice input with no key at all', r.state === 'ok' && r.choice.kind === 'local' && r.choice.label === 'on-device transcriber (base.en-q5_1)')
  r = transcribe.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, ON_DEVICE), { kind: 'cloud' })
  check('pin cloud ⇒ the ledger walk; the on-device road is held back by name', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'openai' && r.skipped.includes('on-device transcriber: held back by MERCURY_VOICE_TRANSCRIBER=cloud'), JSON.stringify(r))
  r = transcribe.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, NO_PACK), { kind: 'on-device' })
  check('pin on-device with no pack ⇒ none naming the pin, never a silent fallback to the key', r.state === 'none' && r.note.startsWith('MERCURY_VOICE_TRANSCRIBER=on-device but') && r.note.endsWith('the pin names itself, no silent fallback'), r.state === 'none' ? r.note : 'ok')
  r = transcribe.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, ON_DEVICE), { kind: 'unset' }, transcribe.TRANSCRIBER_ORDER, { kind: 'family', family: 'openai' })
  check('a saved family that is signed in serves over the present on-device road', r.state === 'ok' && r.choice.kind === 'cloud' && r.choice.family === 'openai' && r.saved?.state === 'serving', JSON.stringify(r.saved))
  r = transcribe.pickTranscriber(['openai'], reads('OpenAI API key (env)', null, ON_DEVICE), { kind: 'unset' }, transcribe.TRANSCRIBER_ORDER, { kind: 'family', family: 'gemini' })
  check('a saved family no longer signed in is named and the default serves, never silently', r.state === 'ok' && r.choice.kind === 'local' && r.saved?.state === 'unavailable' && r.saved.short === 'is not signed in', JSON.stringify(r.saved))
  check('every family answers the table: API-key slots for OpenAI and Gemini, none elsewhere', transcribe.FAMILY_TRANSCRIBER.openai.slot === 'api-key' && transcribe.FAMILY_TRANSCRIBER.gemini.slot === 'api-key' && transcribe.FAMILY_TRANSCRIBER.anthropic.slot === 'none' && Object.values(transcribe.FAMILY_TRANSCRIBER).every(v => v.slot === 'api-key' || v.why !== ''))
  check('the OpenAI rows: the newer transcription row first, the classic one as the fallback', transcribe.OPENAI_TRANSCRIBE_MODELS.join(',') === 'gpt-4o-transcribe,whisper-1')

  let live = transcribe.resolveTranscriber()
  check('LIVE keyless home ⇒ none, the doors with the on-device reason', live.state === 'none' && live.local.state === 'absent' && live.note === transcribe.noTranscriberReceipt(live.local, transcribe.liveTranscriberPin()), JSON.stringify(live))
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
  resetComputedDefaultMemo()
  live = transcribe.resolveTranscriber()
  check('LIVE an OpenAI env key ⇒ OpenAI through the API-key slot', live.state === 'ok' && live.choice.kind === 'cloud' && live.choice.family === 'openai' && live.choice.label === 'OpenAI API key (env)', JSON.stringify(live))
  delete process.env.OPENAI_API_KEY
  resetComputedDefaultMemo()
}

section('§4 the wire shapes against the loopback transcriber — multipart, inline WAV, the row fallback, the deadline')
{
  const take = readFileSync(TONE)
  const fx = await startFixture('wire')
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${fx.port}/v1`
  const openai = await transcribe.transcribeWav(take, { choice: { kind: 'cloud', family: 'openai', slot: 'api-key', label: 'OpenAI API key (env)' } })
  check('OpenAI: the canned transcript comes back through the first row', openai.text === 'the quick brown fox jumps over the lazy dog' && openai.model === 'gpt-4o-transcribe', JSON.stringify(openai))
  let served = posts(fx.lines())
  check('OpenAI: ONE multipart POST /audio/transcriptions carrying the WAV file and the model part', served.length === 1 && served[0]!.includes('/v1/audio/transcriptions') && served[0]!.includes('model=gpt-4o-transcribe') && served[0]!.includes('wav=yes'), served.join(' | '))

  process.env.GEMINI_API_KEY = 'fixture-gemini-key-000000'
  process.env.MERCURY_GEMINI_API_BASE = `http://127.0.0.1:${fx.port}/v1beta`
  const gemini = await transcribe.transcribeWav(take, { choice: { kind: 'cloud', family: 'gemini', slot: 'api-key', label: 'Gemini API key (env-gemini)' } })
  check('Gemini: the canned transcript comes back', gemini.text === 'the quick brown fox jumps over the lazy dog' && gemini.model !== '', JSON.stringify(gemini))
  served = posts(fx.lines())
  check('Gemini: ONE POST models/<row>:generateContent with the WAV inline and the verbatim instruction', served.length === 2 && served[1]!.includes(':generateContent') && served[1]!.includes('wav=yes') && served[1]!.includes('verbatim=yes'), served.join(' | '))
  fx.stop()

  const refusing = await startFixture('fallback', { refuse: 'gpt-4o-transcribe' })
  process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${refusing.port}/v1`
  const fallback = await transcribe.transcribeWav(take, { choice: { kind: 'cloud', family: 'openai', slot: 'api-key', label: 'OpenAI API key (env)' } })
  const rows = posts(refusing.lines())
  check('OpenAI: a 404 on the first row falls to whisper-1 (two POSTs, the second answers)', fallback.model === 'whisper-1' && rows.length === 2 && rows[0]!.includes('model=gpt-4o-transcribe') && rows[1]!.includes('model=whisper-1'), rows.join(' | '))
  refusing.stop()

  const slow = await startFixture('slow', { delayMs: 3000 })
  process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${slow.port}/v1`
  let breach = ''
  try {
    await transcribe.transcribeWav(take, { choice: { kind: 'cloud', family: 'openai', slot: 'api-key', label: 'OpenAI API key (env)' }, deadlineMs: 500 })
  } catch (error) {
    breach = error instanceof Error ? error.message : String(error)
  }
  check('the deadline law: a slow transcriber answers the honest breach line', breach === 'timed out after 0.5s — OpenAI did not answer', breach)
  slow.stop()
  delete process.env.GEMINI_API_KEY
  delete process.env.MERCURY_GEMINI_API_BASE
}

section('§5 the session — the refusals before a take, v/v, the landing, esc, zero network before the stop')
{
  const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
  const { getGlobalConfig } = await import('../../src/utils/config.js')
  const fx = await startFixture('session', { delayMs: 300 })
  process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${fx.port}/v1`
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  resetComputedDefaultMemo()
  pendingInput.initOnce({ text: '', mode: 'prompt', pastedContents: {} })
  session.resetVoiceForTest()
  const fetchCalls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input))
    return realFetch(input, init)
  }) as typeof fetch

  check('voice input is OFF by default', !session.voiceInputEnabled() && !session.voiceSnapshot().enabled)
  let outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('with /speak off, v refuses with the toggle words and no take', outcome.kind === 'refused' && outcome.text === session.VOICE_OFF_RECEIPT && session.voiceSnapshot().phase === 'idle' && session.voiceSnapshot().receipt?.text === session.VOICE_OFF_RECEIPT, JSON.stringify(outcome))

  session.setVoiceInputEnabled(true)
  check('/speak on persists the toggle', session.voiceInputEnabled() && getGlobalConfig().voiceInputEnabled === true && session.voiceSnapshot().enabled)

  delete process.env.MERCURY_VOICE_BACKEND
  process.env.MERCURY_VOICE_PACK_DIR = EMPTY_PACK
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('no backend ⇒ the no-backend receipt BEFORE any take', outcome.kind === 'refused' && outcome.text.startsWith(capture.NO_BACKEND_RECEIPT) && session.voiceSnapshot().phase === 'idle', outcome.text)
  delete process.env.MERCURY_VOICE_PACK_DIR
  process.env.MERCURY_VOICE_BACKEND = 'fixture'

  delete process.env.OPENAI_API_KEY
  resetComputedDefaultMemo()
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('a keyless home ⇒ the no-transcriber receipt BEFORE any take, zero requests', outcome.kind === 'refused' && outcome.text === transcribe.noTranscriberReceipt(transcribe.localTranscriberRead(), transcribe.liveTranscriberPin()) && outcome.text.startsWith('nothing transcribes yet — ') && posts(fx.lines()).length === 0 && fetchCalls.length === 0, outcome.text)
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  resetComputedDefaultMemo()

  pendingInput.edit('hello')
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('v starts a take: recording, on the fixture backend', outcome.kind === 'started' && session.voiceSnapshot().phase === 'recording' && session.voiceSnapshot().backend === 'fixture', JSON.stringify(outcome))
  await sleep(150)
  check('ZERO requests while the take runs (the network tripwire law)', fetchCalls.length === 0 && posts(fx.lines()).length === 0, fetchCalls.join(','))
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('v again stops the take: transcribing', outcome.kind === 'stopping' && session.voiceSnapshot().phase === 'transcribing', JSON.stringify(outcome))
  const busy = await session.toggleVoiceCapture({ env: noTools() })
  check('a press while transcribing is answered, not a second take', busy.kind === 'busy' && busy.text === session.BUSY_RECEIPT)
  check('the words land in the composer, one space from the draft', await until(() => pendingInput.text() === 'hello the quick brown fox jumps over the lazy dog'), pendingInput.text())
  check('…and the session is idle again with the transcribing receipt', await until(() => session.voiceSnapshot().phase === 'idle') && /transcribed by OpenAI \(gpt-4o-transcribe\) · 1s/.test(session.voiceSnapshot().receipt?.text ?? ''), session.voiceSnapshot().receipt?.text ?? '')
  check('exactly ONE request left the box, after the stop', fetchCalls.length === 1 && posts(fx.lines()).length === 1, fetchCalls.join(','))

  pendingInput.edit('')
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('a second take starts on an empty draft', outcome.kind === 'started' && session.voiceSnapshot().phase === 'recording')
  const cancelled = session.cancelVoiceCapture()
  check('esc cancels: idle, the cancel receipt, nothing in the composer', cancelled && session.voiceSnapshot().phase === 'idle' && session.voiceSnapshot().receipt?.text === session.CANCELLED_RECEIPT && pendingInput.text() === '')
  await sleep(200)
  check('a cancelled take makes NO request', fetchCalls.length === 1 && posts(fx.lines()).length === 1, fetchCalls.join(','))
  check('esc with no take answers false', !session.cancelVoiceCapture())

  process.env.MERCURY_VOICE_FIXTURE_WAV = SILENT
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  await session.toggleVoiceCapture({ env: noTools() })
  await until(() => session.voiceSnapshot().phase === 'idle')
  check('a silent take is refused with the permission words, no request', (session.voiceSnapshot().receipt?.text ?? '').startsWith('only silence reached the microphone') && (session.voiceSnapshot().receipt?.text ?? '').includes(capture.microphonePermissionHint()) && fetchCalls.length === 1, session.voiceSnapshot().receipt?.text ?? '')
  check('the permission words per platform: macOS and Windows name the Settings → Microphone path, the other arm names the operating system permission for the terminal', capture.microphonePermissionHint('darwin').includes('Privacy & Security → Microphone') && capture.microphonePermissionHint('win32').includes('Privacy & security → Microphone') && capture.microphonePermissionHint('linux').includes('microphone permission for your terminal'))
  process.env.MERCURY_VOICE_FIXTURE_WAV = TONE

  process.env.MERCURY_VOICE_BOUND_MS = '120'
  pendingInput.edit('')
  const seen: string[] = []
  const unsubscribe = session.subscribeVoice(() => {
    const text = session.voiceSnapshot().receipt?.text
    if (text !== undefined && !seen.includes(text)) seen.push(text)
  })
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('a take opens under the seam bound', outcome.kind === 'started' && session.voiceSnapshot().phase === 'recording', JSON.stringify(outcome))
  await until(() => session.voiceSnapshot().phase === 'idle', 5000)
  unsubscribe()
  delete process.env.MERCURY_VOICE_BOUND_MS
  check('the bound stops the take by itself: the bound receipt, then the words land', seen.includes('capture stopped at the 0.1-second bound — transcribing') && pendingInput.text() === 'the quick brown fox jumps over the lazy dog', `${seen.join(' | ')} · draft=${pendingInput.text()}`)
  check('…one more request, after the bound — never before', fetchCalls.length === 2 && posts(fx.lines()).length === 2, fetchCalls.join(','))

  pendingInput.edit('')
  outcome = await session.toggleVoiceCapture({ env: noTools() })
  check('a take is open before the quit', outcome.kind === 'started' && session.voiceSnapshot().phase === 'recording')
  const released = session.releaseVoiceCaptureOnExit()
  await sleep(150)
  check('the exit release drops the open take: idle, no request, no receipt', released && session.voiceSnapshot().phase === 'idle' && !session.releaseVoiceCaptureOnExit() && fetchCalls.length === 2 && session.voiceSnapshot().receipt?.text !== session.CANCELLED_RECEIPT, `${session.voiceSnapshot().phase} · ${session.voiceSnapshot().receipt?.text ?? ''}`)
  check('the release is registered with the shutdown cleanups (the one exit owner)', readFileSync(join(ROOT, 'src', 'services', 'voice', 'voiceSession.ts'), 'utf8').includes('registerCleanup(async () => {\n  releaseVoiceCaptureOnExit()'))

  const onDeviceSkip = seedOnDeviceModel()
  if (onDeviceSkip !== null) {
    console.log(`  [WARN] the on-device legs are skipped — ${onDeviceSkip}`)
  } else {
    process.env.MERCURY_WHISPER_MODEL = ON_DEVICE_MODEL
    process.env.MERCURY_VOICE_FIXTURE_WAV = SPEECH
    const before = fetchCalls.length
    const servedBefore = posts(fx.lines()).length
    pendingInput.edit('')
    outcome = await session.toggleVoiceCapture({ env: noTools() })
    check('with the pack and the model present a take starts on the on-device road, beside the signed-in key', outcome.kind === 'started' && outcome.text === `recording — space or esc stops it (on-device transcriber (${ON_DEVICE_MODEL}) transcribes)`, JSON.stringify(outcome))
    await sleep(100)
    outcome = await session.toggleVoiceCapture({ env: noTools() })
    check('the take stops: transcribing', outcome.kind === 'stopping')
    check('the words land in the composer, decoded on this machine (matched loosely)', await until(() => /lighthouse|seven|ships/i.test(pendingInput.text()), 60_000), pendingInput.text())
    check('…the receipt says so, naming the model', await until(() => session.voiceSnapshot().phase === 'idle') && new RegExp(`^transcribed on this machine \\(${ON_DEVICE_MODEL}\\) · \\d+s$`).test(session.voiceSnapshot().receipt?.text ?? ''), session.voiceSnapshot().receipt?.text ?? '')
    check('ZERO requests left the box — the fetch spy and the loopback ledger did not move', fetchCalls.length === before && posts(fx.lines()).length === servedBefore, fetchCalls.slice(before).join(','))
    process.env.MERCURY_VOICE_TRANSCRIBER = 'cloud'
    pendingInput.edit('')
    process.env.MERCURY_VOICE_FIXTURE_WAV = TONE
    outcome = await session.toggleVoiceCapture({ env: noTools() })
    check('pin cloud ⇒ the take starts on the signed-in family, the on-device road held back', outcome.kind === 'started' && outcome.text.includes('OpenAI API key (env) transcribes'), JSON.stringify(outcome))
    await session.toggleVoiceCapture({ env: noTools() })
    check('…and exactly one request leaves, after the stop', await until(() => session.voiceSnapshot().phase === 'idle') && fetchCalls.length === before + 1 && posts(fx.lines()).length === servedBefore + 1, fetchCalls.slice(before).join(','))
    delete process.env.MERCURY_VOICE_TRANSCRIBER
    session.setVoiceTranscriberChoice('openai')
    check('/speak options openai persists the choice', getGlobalConfig().voiceTranscriber === 'openai')
    const beforeSaved = fetchCalls.length
    pendingInput.edit('')
    outcome = await session.toggleVoiceCapture({ env: noTools() })
    check('the saved family serves over the present pack: the started receipt names its credential', outcome.kind === 'started' && outcome.text === 'recording — space or esc stops it (OpenAI API key (env) transcribes)', JSON.stringify(outcome))
    await session.toggleVoiceCapture({ env: noTools() })
    check('…and exactly one request leaves', await until(() => session.voiceSnapshot().phase === 'idle') && fetchCalls.length === beforeSaved + 1, fetchCalls.slice(beforeSaved).join(','))
    session.setVoiceTranscriberChoice('gemini')
    pendingInput.edit('')
    process.env.MERCURY_VOICE_FIXTURE_WAV = SPEECH
    outcome = await session.toggleVoiceCapture({ env: noTools() })
    check('a saved family that is not signed in: the started receipt names it and the on-device road transcribes', outcome.kind === 'started' && outcome.text === 'recording — space or esc stops it (on-device transcribes — your saved Gemini is not signed in)', JSON.stringify(outcome))
    await session.toggleVoiceCapture({ env: noTools() })
    check('…the words land on this machine with no request', await until(() => /lighthouse|seven|ships/i.test(pendingInput.text()), 60_000) && (await until(() => session.voiceSnapshot().phase === 'idle')) && fetchCalls.length === beforeSaved + 1, `${pendingInput.text()} · ${fetchCalls.slice(beforeSaved).join(',')}`)
    session.setVoiceTranscriberChoice(null)
    check('/speak options default clears the saved choice', getGlobalConfig().voiceTranscriber === undefined)
    process.env.MERCURY_VOICE_FIXTURE_WAV = TONE
    delete process.env.MERCURY_WHISPER_MODEL
    transcribe.resetLocalTranscriberForTest()
  }

  session.setVoiceInputEnabled(false)
  check('/speak off persists', !session.voiceInputEnabled() && getGlobalConfig().voiceInputEnabled === false)
  globalThis.fetch = realFetch
  fx.stop()
}

section('§6 the doctor row and the commands')
{
  const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
  const report = await import('../../src/utils/healthReport.js')
  const row = async (): Promise<{ status: string; evidence: string; detail: string; section: string }> => {
    const cert = await report.runHealthReport({ depth: 'fast' })
    for (const s of cert.sections) {
      const r = s.checks.find(c => c.id === 'iface-voice')
      if (r) return { status: String(r.status), evidence: String(r.evidence), detail: String(r.detail ?? ''), section: s.title }
    }
    return { status: 'absent', evidence: '', detail: '', section: '' }
  }
  delete process.env.OPENAI_API_KEY
  delete process.env.MERCURY_VOICE_BACKEND
  process.env.MERCURY_VOICE_PACK_DIR = EMPTY_PACK
  resetComputedDefaultMemo()
  const machinePath = process.env.PATH
  process.env.PATH = EMPTY_BIN
  let r = await row()
  process.env.PATH = machinePath
  check('the Voice input row sits in INTERFACE', r.section === 'INTERFACE', r.section)
  check('keyless, no backend ⇒ info naming both: none + the receipts, /speak off', r.status === 'info' && r.evidence.includes('backend: none') && r.evidence.includes(capture.NO_BACKEND_RECEIPT.slice(0, 22)) && r.evidence.includes('transcriber: none — nothing transcribes yet') && r.evidence.includes(transcribe.NO_TRANSCRIBER_DOORS) && r.evidence.includes('/speak off'), `${r.status}: ${r.evidence}`)
  check('the detail carries the permission words and the privacy line', r.detail.includes('microphone permission') && r.detail.includes('audio leaves the box only'), r.detail)
  check('the detail says Anthropic has no speech-to-text endpoint', r.detail.includes('Anthropic: no speech-to-text endpoint'))
  delete process.env.MERCURY_VOICE_PACK_DIR
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  resetComputedDefaultMemo()
  r = await row()
  check('a backend and a transcriber ⇒ ok, both named', r.status === 'ok' && r.evidence.includes('backend: fixture WAV') && r.evidence.includes('transcriber: OpenAI — OpenAI API key (env)'), `${r.status}: ${r.evidence}`)
  check('the privacy line: nothing is written to disk without the debug seam', r.detail.includes('nothing is written to disk'), r.detail)
  const dumpDir = join(SCRATCH, 'debug-dump')
  process.env.MERCURY_VOICE_DEBUG_WAV_DIR = dumpDir
  r = await row()
  check('…and names the debug directory while the seam is set, never the reassurance', r.detail.includes(`a debug copy of every take is written to ${dumpDir} (MERCURY_VOICE_DEBUG_WAV_DIR)`) && !r.detail.includes('nothing is written to disk'), r.detail)
  delete process.env.MERCURY_VOICE_DEBUG_WAV_DIR
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-000000000000000000000000'
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  resetComputedDefaultMemo()
  r = await row()
  const anthropicLines = r.detail.split('\n').filter(l => l.includes('Anthropic: no speech-to-text endpoint'))
  check('with Anthropic signed in it is named ONCE — among the families passed over, with its reason, without blame', anthropicLines.length === 1 && anthropicLines[0]!.startsWith('families passed over:'), r.detail)
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  resetComputedDefaultMemo()

  process.env.MERCURY_WHISPER_PACK_DIR = EMPTY_PACK
  r = await row()
  check('pack pin broken ⇒ the cloud road serves and the detail names the pin, no silent fallback', r.status === 'ok' && r.evidence.includes('transcriber: OpenAI — OpenAI API key (env)') && r.detail.includes('on-device transcriber: MERCURY_WHISPER_PACK_DIR set but') && r.detail.includes('the pin names itself, no silent fallback'), r.detail)
  delete process.env.MERCURY_WHISPER_PACK_DIR
  const packHere = whisperPack.resolveWhisperPackDir().state === 'ok'
  if (!packHere) {
    r = await row()
    check('pack absent ⇒ the cloud road serves and the detail names the remedy that fits a checkout', r.status === 'ok' && r.detail.includes(`on-device transcriber: ${whisperPack.whisperPackAbsentNote()}`) && r.detail.includes('build-whisper.ts'), r.detail)
    console.log('  [WARN] the on-device present states are skipped — the pack is not built on this host (cargo and cmake)')
  } else {
    r = await row()
    check('pack present, model missing ⇒ the cloud road serves; the detail names the download door with the file and the size', r.status === 'ok' && r.detail.includes('on-device transcriber: pack present, model missing — /speak download fetches ggml-base.en-q5_1.bin (60 MB)') && r.detail.includes('on-device transcription needs a one-time 60 MB download') && r.detail.includes('/speak download starts it'), r.detail)
    process.env.MERCURY_VOICE_TRANSCRIBER = 'on-device'
    r = await row()
    check('pin on-device with the model missing ⇒ none naming the pin, info never a fault', r.status === 'info' && r.evidence.includes('transcriber: none — MERCURY_VOICE_TRANSCRIBER=on-device but the on-device transcriber is pack present, model missing') && r.evidence.includes('the pin names itself, no silent fallback'), r.evidence)
    delete process.env.MERCURY_VOICE_TRANSCRIBER
    const seeded = seedOnDeviceModel()
    if (seeded !== null) {
      console.log(`  [WARN] the on-device present state is skipped — ${seeded}`)
    } else {
      process.env.MERCURY_WHISPER_MODEL = ON_DEVICE_MODEL
      r = await row()
      check('pack and model present ⇒ ok; the evidence names the engine, the model and the pack', r.status === 'ok' && new RegExp(`transcriber: on-device — whisper\\.cpp ${ON_DEVICE_MODEL} \\(pack \\S+ \\S+, the checkout\\)`).test(r.evidence), r.evidence)
      check('…the detail: the on-device line, the cost line with the memory words, the families signed in but not used', r.detail.includes(`transcriber: on-device (${ON_DEVICE_MODEL})`) && r.detail.includes('on-device: whisper.cpp ') && r.detail.includes('MB more memory while the model is loaded') && r.detail.includes('cloud families signed in, not used: OpenAI (OpenAI API key (env)) — MERCURY_VOICE_TRANSCRIBER=openai chooses it'), r.detail)
      check('…the privacy line: audio never leaves the box', r.detail.includes('audio never leaves the box: the take is transcribed on this machine; nothing is written to disk') && !r.detail.includes('audio leaves the box only'), r.detail)
      process.env.MERCURY_VOICE_TRANSCRIBER = 'cloud'
      r = await row()
      check('pin cloud ⇒ the family serves and the on-device road is named as held back', r.status === 'ok' && r.evidence.includes('transcriber: OpenAI — OpenAI API key (env)') && r.detail.includes(`on-device transcriber: usable (${ON_DEVICE_MODEL}), held back by MERCURY_VOICE_TRANSCRIBER`) && r.detail.includes('families passed over: on-device transcriber: held back by MERCURY_VOICE_TRANSCRIBER=cloud'), r.detail)
      delete process.env.MERCURY_VOICE_TRANSCRIBER
      delete process.env.MERCURY_WHISPER_MODEL
    }
  }

  const { builtinCommands, commandSeat } = await import('../../src/commands.js')
  const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.js')
  const roster = builtinCommands()
  const speak = roster.find(c => c.name === 'speak')
  const voice = roster.find(c => c.name === 'voice')
  check('/speak and /voice are registered, screen-seat local commands', speak !== undefined && voice !== undefined && commandSeat(speak!) === 'screen' && commandSeat(voice!) === 'screen' && speak!.type === 'local' && voice!.type === 'local')
  const domainOf = (n: string): string | undefined => COMMAND_DOMAINS.find(d => d.names.includes(n))?.key
  check('both are curated into config & setup', domainOf('speak') === 'config' && domainOf('voice') === 'config')
  const speakCall = (await import('../../src/commands/speak/speak.js')).call
  const ctx = {} as never
  let out = await speakCall('on', ctx)
  check('/speak on turns voice input on and says so', out.type === 'text' && out.value.startsWith('voice input ON') && session.voiceInputEnabled(), out.type === 'text' ? out.value : out.type)
  out = await speakCall('', ctx)
  check('bare /speak answers the status: the toggle, the backend, the transcriber', out.type === 'text' && out.value.includes('voice input ON') && out.value.includes('backend: fixture WAV') && out.value.includes('transcriber: OpenAI'), out.type === 'text' ? out.value : out.type)
  out = await speakCall('loud', ctx)
  check('/speak with another word answers the usage line', out.type === 'text' && out.value.includes('takes on, off, options or download'))
  process.env.MERCURY_WHISPER_PACK_DIR = EMPTY_PACK
  out = await speakCall('download', ctx)
  check('/speak download without a usable pack refuses, naming the pin and that the download waits for the pack', out.type === 'text' && out.value.startsWith('on-device transcriber: MERCURY_WHISPER_PACK_DIR set but') && out.value.endsWith('the model download waits for the pack'), out.type === 'text' ? out.value : out.type)
  delete process.env.MERCURY_WHISPER_PACK_DIR
  out = await speakCall('download bogus', ctx)
  check('/speak download with a name outside the catalogue names the catalogue', out.type === 'text' && (out.value.includes('takes a model name from the catalogue') || out.value.endsWith('the model download waits for the pack')), out.type === 'text' ? out.value : out.type)
  const { getGlobalConfig: savedConfig } = await import('../../src/utils/config.js')
  process.env.OPENAI_API_KEY = 'sk-fixture-voice-000000000000000000000000'
  resetComputedDefaultMemo()
  out = await speakCall('options', ctx)
  const listing = out.type === 'text' ? out.value : ''
  check('/speak options lists every transcriber this install could use, marks the one that serves now, and names the switch', listing.startsWith('transcribers this install can use — /speak options <name> makes one your default') && /^● (on-device|openai) — /m.test(listing) && listing.includes('○ gemini — Gemini: not signed in — /logins gemini (API key)') && listing.includes('default: the shipped one'), listing)
  out = await speakCall('options openai', ctx)
  check('/speak options openai saves the choice and says so', out.type === 'text' && out.value.startsWith('default transcriber: openai (saved)') && out.value.includes('● openai — OpenAI: OpenAI API key (env) (serves now, your saved choice)') && savedConfig().voiceTranscriber === 'openai', out.type === 'text' ? out.value : out.type)
  out = await speakCall('', ctx)
  check('bare /speak names the saved choice as the default', out.type === 'text' && out.value.includes('default: your saved choice — OpenAI'), out.type === 'text' ? out.value : out.type)
  r = await row()
  check('the doctor row carries the default line with the saved choice', r.detail.includes('default: your saved choice — OpenAI'), r.detail)
  out = await speakCall('options bogus', ctx)
  check('/speak options with a word outside the vocabulary answers the vocabulary', out.type === 'text' && out.value.startsWith('/speak options takes one of on-device · openai · gemini or default (got "bogus")'), out.type === 'text' ? out.value : out.type)
  out = await speakCall('options default', ctx)
  check('/speak options default restores the shipped default', out.type === 'text' && out.value.startsWith('default transcriber: the shipped default (saved choice cleared)') && savedConfig().voiceTranscriber === undefined, out.type === 'text' ? out.value : out.type)
  out = await speakCall('off', ctx)
  check('/speak off turns it off', out.type === 'text' && out.value.startsWith('voice input OFF') && !session.voiceInputEnabled())
  const voiceCall = (await import('../../src/commands/voice/voice.js')).call
  out = await voiceCall('', ctx)
  check('/voice with voice input off answers the toggle words', out.type === 'text' && out.value === session.VOICE_OFF_RECEIPT, out.type === 'text' ? out.value : out.type)
  delete process.env.OPENAI_API_KEY
  delete process.env.MERCURY_OPENAI_API_BASE
}

console.log('\n[10] the stream error record: a device that went away is one notice, an underrun a debug count')
{
  const clean = session.streamErrorNotice({ transient: 0, lastTransient: null, fatal: null })
  check('a clean stream raises no notice', clean === null, JSON.stringify(clean))
  const transient = session.streamErrorNotice({ transient: 3, lastTransient: 'A buffer underrun or overrun occurred.', fatal: null })
  check('an underrun or overrun is transient: a debug line carrying the count and the last text, never an operator notice', transient !== null && transient.kind === 'transient' && transient.debug === 'voice capture: 3 transient stream errors (A buffer underrun or overrun occurred.)', JSON.stringify(transient))
  const one = session.streamErrorNotice({ transient: 1, lastTransient: null, fatal: null })
  check('the count reads singular for one', one !== null && one.kind === 'transient' && one.debug.startsWith('voice capture: 1 transient stream error ('), JSON.stringify(one))
  const fatal = session.streamErrorNotice({ transient: 2, lastTransient: 'A buffer underrun or overrun occurred.', fatal: 'The requested device is no longer available.' })
  check('a device that went away is ONE real notice naming the failure, and it outranks the transient count', fatal !== null && fatal.kind === 'fatal' && fatal.text === 'the input stream failed during the take — The requested device is no longer available.', JSON.stringify(fatal))
  check('the status line has nothing to say before any take', session.lastTakeStreamWords(null) === null)
  check('the status line names a clean last take', session.lastTakeStreamWords({ transient: 0, lastTransient: null, fatal: null }) === 'last take: the input stream stayed clean')
  check('the status line names the transient count and that the capture kept going', session.lastTakeStreamWords({ transient: 2, lastTransient: 'x', fatal: null }) === 'last take: 2 transient stream errors, the capture kept going')
  check('the status line names the fatal failure', session.lastTakeStreamWords({ transient: 0, lastTransient: null, fatal: 'gone' }) === 'last take: the input stream failed during the take — gone')
  const sessionSource = readFileSync(join(ROOT, 'src', 'services', 'voice', 'voiceSession.ts'), 'utf8')
  check('the stop path records the take\'s stream errors, logs a transient count for debugging and receipts a fatal one', sessionSource.includes('lastStreamErrors = result.streamErrors') && sessionSource.includes("if (streamNotice?.kind === 'transient') logForDebugging(streamNotice.debug)") && sessionSource.includes("if (streamNotice?.kind === 'fatal') {\n      receipt(`${streamNotice.text} — ${microphonePermissionHint()}`, 'error')"))
  const captureSource = readFileSync(join(ROOT, 'src', 'services', 'voice', 'capture.ts'), 'utf8')
  check('the vendored capture reads the addon\'s error record after the take closes (lastCaptureErrors) and while it runs (captureErrors)', captureSource.includes('done ? load.addon.lastCaptureErrors(handle) : load.addon.captureErrors(handle)'))
  check('a fixture take carries the empty record', (await (await capture.startCapture({ backend: { state: 'ok', kind: 'fixture', detail: 'fixture', pinned: true } })).stop()).streamErrors.transient === 0)
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-voice-owners: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-voice-owners: green')
process.exit(0)
