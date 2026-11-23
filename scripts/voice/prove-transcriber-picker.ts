import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localFixture } from './localFixture.ts'

const scratch = mkdtempSync(join(tmpdir(), 'transcriber-picker-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const t = await import('../../src/integrations/voice/transcribe.js')
const pack = await import('../../src/integrations/voice/whisperPack.js')
const { describeVoiceReadiness } = await import('../../src/integrations/voice/voiceSession.js')
const fx = localFixture(join(scratch, 'pack'))
Object.assign(process.env, fx.env)
process.env.OPENAI_API_KEY = 'fixture-not-a-real-key'
process.env.GEMINI_API_KEY = 'fixture-not-a-real-key'
let fetches = 0
const realFetch = globalThis.fetch
globalThis.fetch = (() => { fetches++; throw new Error('voice must not fetch') }) as typeof fetch
try {
  let live = t.resolveTranscriber()
  assert.equal(live.state, 'ok', 'resolveTranscriber in src/integrations/voice/transcribe.ts should return state ok when the local fixture pack is present')
  assert.equal(live.state === 'ok' && live.choice.kind, 'local', 'resolveTranscriber in src/integrations/voice/transcribe.ts should choose the local transcriber when the pack is present')
  const words = [describeVoiceReadiness().detail]
  const empty = join(scratch, 'missing')
  mkdirSync(empty)
  process.env.MERCURY_WHISPER_PACK_DIR = empty
  pack.resetWhisperAddonForTest()
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none', 'absent pack cannot fall back to a signed-in family')
  assert.match(live.state === 'none' ? live.note : '', /MERCURY_WHISPER_PACK_DIR is unusable/, 'resolveTranscriber in src/integrations/voice/transcribe.ts should put MERCURY_WHISPER_PACK_DIR is unusable in its note when the pack dir is empty')
  words.push(describeVoiceReadiness().detail)
  Object.assign(process.env, fx.env)
  pack.resetWhisperAddonForTest()
  pack.seedCpuFloorProbeForTest({ state: 'unmet', via: 'flags', missing: ['avx2'] })
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none', 'resolveTranscriber in src/integrations/voice/transcribe.ts should return state none when the CPU floor probe is unmet')
  assert.match(live.state === 'none' ? live.note : '', /CPU lacks AVX2/, 'resolveTranscriber in src/integrations/voice/transcribe.ts should name the missing AVX2 in its note when the CPU floor is unmet')
  words.push(describeVoiceReadiness().detail)
  pack.resetWhisperAddonForTest()
  const broken = localFixture(join(scratch, 'broken'))
  writeFileSync(join(scratch, 'broken/fixture.cjs'), "throw new Error('fixture missing library')")
  Object.assign(process.env, broken.env)
  live = t.resolveTranscriber()
  assert.equal(live.state, 'none', 'resolveTranscriber in src/integrations/voice/transcribe.ts should return state none when the addon cannot load')
  assert.match(live.state === 'none' ? live.note : '', /fixture missing library/, 'resolveTranscriber in src/integrations/voice/transcribe.ts should carry the addon load error in its note')
  words.push(describeVoiceReadiness().detail)
  assert.doesNotMatch(words.join('\n'), /API key|\/logins|openai|gemini/i, 'describeVoiceReadiness in src/integrations/voice/voiceSession.ts should not mention API keys, /logins or a cloud family in its detail')
  assert.equal(fetches, 0, 'voice resolution must not call fetch; remove the network call from the path through src/integrations/voice/transcribe.ts')
  assert.equal(t.localTranscribeDeadlineMs(30_000), 150_000, 'localTranscribeDeadlineMs in src/integrations/voice/transcribe.ts should return 150000 for 30000 ms of audio')
  assert.equal(t.localTranscribeDeadlineMs(-5), 120_000, 'localTranscribeDeadlineMs in src/integrations/voice/transcribe.ts should return the 120000 floor for negative audio length')
  assert.equal(t.stripNonSpeechMarkers('[BLANK_AUDIO] hello (silence) world [MUSIC]'), 'hello world', 'stripNonSpeechMarkers in src/integrations/voice/transcribe.ts should drop bracketed and silence markers')
  assert.equal(t.stripNonSpeechMarkers('(yes) fine'), '(yes) fine', 'stripNonSpeechMarkers in src/integrations/voice/transcribe.ts should keep ordinary parenthesised words')
  assert.equal(new t.TranscribeError('local', 'reason').kind, 'local', 'TranscribeError in src/integrations/voice/transcribe.ts should keep the kind it is given')
  const { getFlagSpec, flagEnv } = await import('../../src/platform/substrate/flagRegistry.js')
  const retiredPin = 'MERCURY_VOICE_' + 'TRANSCRIBER'
  assert.equal(getFlagSpec(retiredPin), undefined, 'the retired transcriber selection flag should not be registered; remove it from FLAG_REGISTRY in the flag registry')
  assert.throws(() => flagEnv(retiredPin), /unregistered flag/, 'flagEnv in the flag registry (FLAG_REGISTRY) should throw unregistered flag for the retired transcriber selection flag')
  console.log('prove-transcriber-picker: green — present, absent, CPU floor, cannot-load, no cloud wires or selection pin')
} finally {
  globalThis.fetch = realFetch
  pack.resetWhisperAddonForTest()
  rmSync(scratch, { recursive: true, force: true })
}
