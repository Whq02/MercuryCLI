import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localFixture } from './localFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'voice-owners-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_VOICE_BACKEND', 'MERCURY_VOICE_FIXTURE_WAV', 'MERCURY_VOICE_DEBUG_WAV_DIR', 'MERCURY_VOICE_PACK_DIR', 'MERCURY_WHISPER_PACK_DIR', 'MERCURY_WHISPER_MODEL', 'MERCURY_VOICE_BOUND_MS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config.js')
enableConfigs()
const wav = await import('../../src/services/voice/wav.js')
const capture = await import('../../src/services/voice/capture.js')
const transcribe = await import('../../src/services/voice/transcribe.js')
const pack = await import('../../src/services/voice/whisperPack.js')
const session = await import('../../src/services/voice/voiceSession.js')
const pending = await import('../../src/input-core/pending-input.js')
const { call } = await import('../../src/commands/voice/voice.js')
const fx = localFixture(join(scratch, 'pack'), 'the quick brown fox', 100)
Object.assign(process.env, fx.env)
const tone = join(scratch, 'tone.wav')
const silent = join(scratch, 'silent.wav')
writeFileSync(tone, wav.synthesizeToneWav({ seconds: 1, hz: 440 }))
writeFileSync(silent, wav.encodeWav(new Int16Array(wav.VOICE_SAMPLE_RATE)))
const empty = join(scratch, 'empty')
mkdirSync(empty)
const noTools = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: empty })
const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  assert.ok(predicate(), 'product state must settle before deadline')
}
const realFetch = globalThis.fetch
let requests = 0
globalThis.fetch = (() => { requests++; throw new Error('unexpected voice request') }) as typeof fetch
try {
  const pcm = new Int16Array(wav.VOICE_SAMPLE_RATE)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? -1000 : 1000
  const encoded = wav.encodeWav(pcm)
  assert.equal(encoded.length, 32_044)
  const read = wav.readWav(encoded)
  assert.ok(read.ok && wav.isVoiceWavShape(read.header) && read.header.dataBytes === 32_000)
  encoded.writeUInt32LE(0xffffffff, 40)
  const clamped = wav.readWav(encoded)
  assert.ok(clamped.ok && clamped.header.dataBytes === 32_000)
  assert.equal(wav.readWav(Buffer.alloc(100, 7)).ok, false)
  assert.ok(wav.pcmIsSilent(new Int16Array(1600)) && !wav.pcmIsSilent(pcm))
  assert.equal(wav.pcmDurationMs(pcm), 1000)
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  let backend = capture.resolveCaptureBackend(noTools())
  assert.ok(backend.state === 'none' && backend.note.includes('MERCURY_VOICE_FIXTURE_WAV'))
  process.env.MERCURY_VOICE_FIXTURE_WAV = tone
  backend = capture.resolveCaptureBackend(noTools())
  assert.ok(backend.state === 'ok' && backend.kind === 'fixture' && backend.pinned)
  process.env.MERCURY_VOICE_BACKEND = 'bogus'
  backend = capture.resolveCaptureBackend(noTools())
  assert.ok(backend.state === 'none' && backend.note.includes('vendored') && backend.note.includes('ffmpeg'))
  process.env.MERCURY_VOICE_BACKEND = 'sox'
  backend = capture.resolveCaptureBackend(noTools())
  assert.ok(backend.state === 'none' && backend.note.includes('not on PATH'))
  delete process.env.MERCURY_VOICE_BACKEND
  process.env.MERCURY_VOICE_PACK_DIR = empty
  backend = capture.resolveCaptureBackend(noTools())
  assert.ok(backend.state === 'none' && backend.tried.join(',') === 'vendored,sox,arecord,ffmpeg')
  assert.ok(capture.noBackendReceipt(null, 'win32').includes('winget install ffmpeg'))
  assert.ok(capture.noBackendReceipt(null, 'darwin').includes('brew install ffmpeg'))
  assert.ok(capture.noBackendReceipt(null, 'linux').includes('apt install ffmpeg'))
  delete process.env.MERCURY_VOICE_PACK_DIR
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  assert.equal(capture.CAPTURE_BOUND_MS, 300_000)
  process.env.MERCURY_VOICE_BOUND_MS = '80'
  assert.equal(capture.captureBoundMs(), 80)
  process.env.MERCURY_VOICE_BOUND_MS = '300001'
  assert.equal(capture.captureBoundMs(), 300_000)
  process.env.MERCURY_VOICE_BOUND_MS = 'soon'
  assert.equal(capture.captureBoundMs(), 300_000)
  delete process.env.MERCURY_VOICE_BOUND_MS
  assert.equal(session.boundLabel(300_000), '5-minute')
  assert.equal(session.boundLabel(1500), '1.5-second')
  const take = await capture.startCapture({ env: noTools() })
  const result = await take.stop()
  assert.equal(await take.stop(), result)
  assert.ok(result.durationMs === 1000 && !result.silent && !result.autoStopped)
  assert.equal(result.streamErrors.transient, 0)
  let bounded = 0
  const auto = await capture.startCapture({ env: noTools(), boundMs: 60, onAutoStop: () => bounded++ })
  await until(() => bounded === 1)
  assert.equal((await auto.stop()).autoStopped, true)
  const cancelled = await capture.startCapture({ env: noTools() })
  cancelled.cancel()
  await assert.rejects(cancelled.stop(), /cancelled/)
  const dump = join(scratch, 'dump')
  assert.equal(existsSync(dump), false)
  process.env.MERCURY_VOICE_DEBUG_WAV_DIR = dump
  await (await capture.startCapture({ env: noTools() })).stop()
  assert.equal(readdirSync(dump).filter(f => /^capture-\d+\.wav$/.test(f)).length, 1)
  delete process.env.MERCURY_VOICE_DEBUG_WAV_DIR
  pending.initOnce({ text: 'hello', mode: 'prompt', pastedContents: {} })
  assert.equal(session.voiceInputEnabled(), false)
  assert.equal((await session.toggleVoiceCapture()).text, session.VOICE_OFF_RECEIPT)
  assert.equal((await call('on', {} as never)).type, 'text')
  assert.equal(getGlobalConfig().voiceInputEnabled, true)
  delete process.env.MERCURY_VOICE_BACKEND
  process.env.MERCURY_VOICE_PACK_DIR = empty
  const noBackend = await session.toggleVoiceCapture({ env: noTools() })
  assert.equal(noBackend.kind, 'refused')
  assert.ok(noBackend.text.startsWith(capture.NO_BACKEND_RECEIPT))
  assert.equal(session.voiceSnapshot().phase, 'idle')
  assert.equal(fx.calls(), 0)
  delete process.env.MERCURY_VOICE_PACK_DIR
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  let outcome = await session.toggleVoiceCapture()
  assert.equal(outcome.kind, 'started')
  assert.equal(fx.calls(), 0)
  assert.match(session.describeVoiceStatus(), /this take: the input stream is clean/)
  assert.equal((await session.toggleVoiceCapture()).kind, 'stopping')
  assert.equal((await session.toggleVoiceCapture()).text, session.BUSY_RECEIPT)
  await until(() => session.voiceSnapshot().phase === 'idle')
  assert.equal(pending.text(), 'hello the quick brown fox')
  assert.equal(fx.calls(), 1)
  assert.match(session.voiceSnapshot().receipt?.text ?? '', /transcribed on this machine/)
  assert.match(session.describeVoiceStatus(), /last take: the input stream stayed clean/)
  const words = [session.describeVoiceStatus(), session.describeVoiceReadiness().detail]
  assert.equal(session.describeVoiceReadiness().ready, true)
  assert.match(session.describeVoiceReadiness().detail, /audio never leaves the box.*nothing is written to disk/)
  process.env.MERCURY_VOICE_DEBUG_WAV_DIR = dump
  assert.ok(session.describeVoiceReadiness().detail.includes(`a debug copy of every take is written to ${dump}`))
  assert.ok(!session.describeVoiceReadiness().detail.includes('nothing is written to disk'))
  delete process.env.MERCURY_VOICE_DEBUG_WAV_DIR
  const healthSource = readFileSync(join(import.meta.dir, '../../src/utils/healthReport.ts'), 'utf8')
  const healthRow = healthSource.slice(healthSource.indexOf("id: 'iface-voice'"), healthSource.indexOf("id: 'iface-computer-use'"))
  assert.ok(healthRow.includes('const readiness = describeVoiceReadiness()'))
  assert.ok(healthRow.includes("readiness.ready ? ('ok' as const) : ('info' as const)"))
  assert.ok(healthRow.includes('evidence: readiness.line, detail: readiness.detail'))
  assert.doesNotMatch(words.join('\n'), /API key|\/logins|openai|gemini/i)
  pending.edit('')
  await session.toggleVoiceCapture()
  assert.equal(session.cancelVoiceCapture(), true)
  assert.equal(session.voiceSnapshot().receipt?.text, session.CANCELLED_RECEIPT)
  assert.equal(session.cancelVoiceCapture(), false)
  assert.equal(pending.text(), '')
  assert.equal(fx.calls(), 1)
  process.env.MERCURY_VOICE_FIXTURE_WAV = silent
  await session.toggleVoiceCapture()
  await session.toggleVoiceCapture()
  await until(() => session.voiceSnapshot().phase === 'idle')
  assert.match(session.voiceSnapshot().receipt?.text ?? '', /only silence reached/)
  assert.ok(session.voiceSnapshot().receipt?.text.includes(capture.microphonePermissionHint()))
  assert.equal(fx.calls(), 1)
  process.env.MERCURY_VOICE_FIXTURE_WAV = tone
  process.env.MERCURY_VOICE_BOUND_MS = '120'
  const notices: string[] = []
  const unsubscribe = session.subscribeVoice(() => { notices.push(session.voiceSnapshot().receipt?.text ?? '') })
  await session.toggleVoiceCapture()
  await until(() => session.voiceSnapshot().phase === 'idle')
  unsubscribe()
  assert.ok(notices.includes('capture stopped at the 0.1-second bound — transcribing'))
  assert.equal(pending.text(), 'the quick brown fox')
  assert.equal(fx.calls(), 2)
  delete process.env.MERCURY_VOICE_BOUND_MS
  await session.toggleVoiceCapture()
  assert.equal(session.releaseVoiceCaptureOnExit(), true)
  assert.equal(session.releaseVoiceCaptureOnExit(), false)
  assert.equal(fx.calls(), 2)
  process.env.MERCURY_WHISPER_PACK_DIR = empty
  pack.resetWhisperAddonForTest()
  outcome = await session.toggleVoiceCapture()
  assert.equal(outcome.kind, 'refused')
  assert.equal(session.voiceSnapshot().phase, 'idle')
  assert.equal(session.describeVoiceReadiness().ready, false)
  assert.match(outcome.text, /MERCURY_WHISPER_PACK_DIR/)
  assert.doesNotMatch(outcome.text, /API key|\/logins|openai|gemini/i)
  await call('off', {} as never)
  assert.equal(getGlobalConfig().voiceInputEnabled, false)
  assert.equal((await call('', {} as never)).type, 'text')
  assert.equal(session.streamErrorNotice({ transient: 0, lastTransient: null, fatal: null }), null)
  assert.deepEqual(session.streamErrorNotice({ transient: 3, lastTransient: 'underrun', fatal: null }), { kind: 'transient', debug: 'voice capture: 3 transient stream errors (underrun)' })
  assert.deepEqual(session.streamErrorNotice({ transient: 1, lastTransient: null, fatal: 'gone' }), { kind: 'fatal', text: 'the input stream failed during the take — gone' })
  assert.equal(session.lastTakeStreamWords(null), null)
  assert.equal(session.lastTakeStreamWords({ transient: 2, lastTransient: 'x', fatal: null }), 'last take: 2 transient stream errors, the capture kept going')
  assert.equal(session.lastTakeStreamWords({ transient: 0, lastTransient: null, fatal: 'gone' }), 'last take: the input stream failed during the take — gone')
  assert.equal(requests, 0)
  console.log('prove-voice-owners: green — WAV, capture ladder, bounds, cancellation, session, composer, local transcriber, health and stream errors')
} finally {
  globalThis.fetch = realFetch
  session.resetVoiceForTest()
  transcribe.unloadLocalModels()
  rmSync(scratch, { recursive: true, force: true })
}
