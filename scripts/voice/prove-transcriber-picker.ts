import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { localFixture } from './localFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'transcriber-picker-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const t = await import('../../src/services/voice/transcribe.js')
const pack = await import('../../src/services/voice/whisperPack.js')
const { describeVoiceReadiness } = await import('../../src/services/voice/voiceSession.js')
const fx = localFixture(join(scratch, 'pack'))
Object.assign(process.env, fx.env)
process.env.OPENAI_API_KEY = 'fixture-not-a-real-key'
process.env.GEMINI_API_KEY = 'fixture-not-a-real-key'
let fetches = 0
const realFetch = globalThis.fetch
globalThis.fetch = (() => { fetches++; throw new Error('voice must not fetch') }) as typeof fetch
try {
  let live = t.resolveTranscriber()
  assert.equal(live.state, 'ok')
  assert.equal(live.state === 'ok' && live.choice.kind, 'local')
  const words = [describeVoiceReadiness().detail]
  const empty = join(scratch, 'missing')
  mkdirSync(empty)
  process.env.MERCURY_WHISPER_PACK_DIR = empty
  pack.resetWhisperAddonForTest()
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none', 'absent pack cannot fall back to a signed-in family')
  assert.match(live.state === 'none' ? live.note : '', /MERCURY_WHISPER_PACK_DIR is unusable/)
  words.push(describeVoiceReadiness().detail)
  Object.assign(process.env, fx.env)
  pack.resetWhisperAddonForTest()
  pack.seedCpuFloorProbeForTest({ state: 'unmet', via: 'flags', missing: ['avx2'] })
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none')
  assert.match(live.state === 'none' ? live.note : '', /CPU lacks AVX2/)
  words.push(describeVoiceReadiness().detail)
  pack.resetWhisperAddonForTest()
  const broken = localFixture(join(scratch, 'broken'))
  writeFileSync(join(scratch, 'broken/fixture.cjs'), "throw new Error('fixture missing library')")
  Object.assign(process.env, broken.env)
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none')
  assert.match(live.state === 'none' ? live.note : '', /fixture missing library/)
  words.push(describeVoiceReadiness().detail)
  assert.doesNotMatch(words.join('\n'), /API key|\/logins|openai|gemini/i)
  assert.equal(fetches, 0)
  assert.equal(t.localTranscribeDeadlineMs(30_000), 150_000)
  assert.equal(t.localTranscribeDeadlineMs(-5), 120_000)
  assert.equal(t.stripNonSpeechMarkers('[BLANK_AUDIO] hello (silence) world [MUSIC]'), 'hello world')
  assert.equal(t.stripNonSpeechMarkers('(yes) fine'), '(yes) fine')
  assert.equal(new t.TranscribeError('local', 'reason').kind, 'local')
  const { getFlagSpec, flagEnv } = await import('../../src/substrate/flagRegistry.js')
  const retiredPin = 'MERCURY_VOICE_' + 'TRANSCRIBER'
  assert.equal(getFlagSpec(retiredPin), undefined)
  assert.throws(() => flagEnv(retiredPin), /unregistered flag/)
  const registry = readFileSync(resolve(import.meta.dir, '../../src/substrate/flagRegistry.ts'), 'utf8')
  assert.ok(!registry.includes(retiredPin), 'there is no registered transcriber-selection pin')
  const source = readFileSync(resolve(import.meta.dir, '../../src/services/voice/transcribe.ts'), 'utf8')
  assert.doesNotMatch(source, /audio\/transcriptions|generateContent|providers\//)
  console.log('prove-transcriber-picker: green — present, absent, CPU floor, cannot-load, no cloud wires or selection pin')
} finally {
  globalThis.fetch = realFetch
  pack.resetWhisperAddonForTest()
  rmSync(scratch, { recursive: true, force: true })
}
