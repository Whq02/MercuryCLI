import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localFixture } from '../voice/localFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'media-model-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const fixture = localFixture(join(root, 'driver'), 'The lighthouse guides seven ships.')
process.env.MERCURY_WHISPER_PACK_DIR = fixture.env.MERCURY_WHISPER_PACK_DIR
delete process.env.MERCURY_WHISPER_MODEL
const { whisperDefaultModel, whisperModelsDir, checkWhisperModel } = await import('../../src/integrations/voice/whisperModels.ts')
const { prepareLocalTranscriber } = await import('../../src/integrations/voice/transcribe.ts')
const { voiceInputEnabled } = await import('../../src/integrations/voice/voiceSession.ts')
const { ReadTool } = await import('../../src/tools/read/ReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const context = { options: { engineModel: 'glm-5.3' }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
const row = whisperDefaultModel()
const original = { ...row }
const fetchBefore = globalThis.fetch
const payload = Buffer.alloc(4096, 7)
row.bytes = payload.length
row.sha256 = createHash('sha256').update(payload).digest('hex')
let fetches = 0
let body: Buffer = payload
let httpStatus = 200
globalThis.fetch = (async (input: RequestInfo | URL) => {
  assert.equal(String(input), row.url, 'the speech model download must fetch the default row url from whisperDefaultModel in src/integrations/voice/whisperModels.ts; check the url the download in that file requests')
  fetches++
  return new Response(new Uint8Array(body), { status: httpStatus })
}) as typeof fetch
const source = fileURLToPath(new URL('../voice/fixtures/on-device-take.wav', import.meta.url))
const path = join(root, 'speech.wav')
writeFileSync(path, readFileSync(source))
async function read() {
  const result = await ReadTool.call({ file_path: path }, context as never)
  assert.equal(result.data.type, 'text', 'reading an audio file must return a text transcript; check the audio path of FileReadTool in src/tools/read/ReadTool.ts')
  return (result.data as Extract<typeof result.data, { type: 'text' }>).file.content
}
try {
  assert.equal(checkWhisperModel().state, 'absent', 'a fresh config home must report the speech model absent; check checkWhisperModel in src/integrations/voice/whisperModels.ts')
  assert.equal(voiceInputEnabled(), false, 'dictation must stay off before the model is set up; check voiceInputEnabled in src/integrations/voice/voiceSession.ts')
  assert.equal((await read()).split('\n')[0], 'Transcript · 00:00:02 · Whisper base.en-q5_1 · downloaded ggml-base.en-q5_1.bin (1 MB) — one-time speech model download', 'the first read must download the model once and say so in the transcript header; check the download suffix in src/integrations/voice/fileTranscript.ts and prepareLocalTranscriber in src/integrations/voice/transcribe.ts')
  assert.equal(fetches, 1, 'the first read must fetch the model exactly once; check prepareLocalTranscriber in src/integrations/voice/transcribe.ts')
  assert.equal(checkWhisperModel(undefined, { digest: true }).state, 'present', 'after the download the model must check present with its digest; check checkWhisperModel in src/integrations/voice/whisperModels.ts')
  assert.equal(voiceInputEnabled(), false, 'downloading the model for a file read must not turn dictation on; check voiceInputEnabled in src/integrations/voice/voiceSession.ts')
  assert.equal((await read()).split('\n')[0], 'Transcript · 00:00:02 · Whisper base.en-q5_1', 'the second read must reuse the model and drop the download note from the header; check the download suffix in src/integrations/voice/fileTranscript.ts')
  assert.equal(fetches, 1, 'the second read must not fetch again; check that prepareLocalTranscriber in src/integrations/voice/transcribe.ts reuses a present model')
  assert.equal(fixture.calls(), 1, 'the local transcriber must run exactly once for the first read; check the transcribe path in src/integrations/voice/transcribe.ts')
  const model = join(whisperModelsDir(), row.file)
  rmSync(model)
  await Promise.all([prepareLocalTranscriber(), prepareLocalTranscriber()])
  assert.equal(fetches, 2, 'two concurrent prepareLocalTranscriber calls on a missing model must share one download; check prepareLocalTranscriber in src/integrations/voice/transcribe.ts')
  writeFileSync(model, Buffer.alloc(payload.length, 8))
  await prepareLocalTranscriber()
  assert.equal(fetches, 3, 'a model file with a wrong digest must be fetched again; check prepareLocalTranscriber in src/integrations/voice/transcribe.ts and the digest check in src/integrations/voice/whisperModels.ts')
  assert.equal(checkWhisperModel(undefined, { digest: true }).state, 'present', 'the repaired model must check present with its digest; check checkWhisperModel in src/integrations/voice/whisperModels.ts')
  for (const [bad, refusal] of [[Buffer.alloc(payload.length, 8), /does not match the lock digest/], [payload.subarray(0, 20), /ended at 20 of 4096 bytes/]] as const) {
    rmSync(model, { force: true })
    body = bad
    await assert.rejects(prepareLocalTranscriber(), refusal)
    assert.equal(existsSync(model), false, 'a rejected download must not leave the model file in place; check the download in src/integrations/voice/whisperModels.ts')
    assert.equal(existsSync(`${model}.part`), false, 'a rejected download must remove its .part file; check the download in src/integrations/voice/whisperModels.ts')
    assert.equal(voiceInputEnabled(), false, 'a rejected download must leave dictation off; check voiceInputEnabled in src/integrations/voice/voiceSession.ts')
  }
  httpStatus = 503
  await assert.rejects(prepareLocalTranscriber(), /HTTP 503/)
  assert.equal(existsSync(`${model}.part`), false, 'an HTTP 503 download must remove its .part file; check the download in src/integrations/voice/whisperModels.ts')
  console.log('PASS media model setup: default first-use download under stub, digest and byte checks, reuse, shared preparation, repair and failures; dictation stays off')
} finally {
  globalThis.fetch = fetchBefore
  Object.assign(row, original)
  rmSync(root, { recursive: true, force: true })
}
