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
const { whisperDefaultModel, whisperModelsDir, checkWhisperModel } = await import('../../src/services/voice/whisperModels.ts')
const { prepareLocalTranscriber } = await import('../../src/services/voice/transcribe.ts')
const { voiceInputEnabled } = await import('../../src/services/voice/voiceSession.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
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
  assert.equal(String(input), row.url)
  fetches++
  return new Response(new Uint8Array(body), { status: httpStatus })
}) as typeof fetch
const source = fileURLToPath(new URL('../voice/fixtures/on-device-take.wav', import.meta.url))
const path = join(root, 'speech.wav')
writeFileSync(path, readFileSync(source))
async function read() {
  const result = await FileReadTool.call({ file_path: path }, context as never)
  assert.equal(result.data.type, 'text')
  return (result.data as Extract<typeof result.data, { type: 'text' }>).file.content
}
try {
  assert.equal(checkWhisperModel().state, 'absent')
  assert.equal(voiceInputEnabled(), false)
  assert.equal((await read()).split('\n')[0], 'Transcript · 00:00:02 · Whisper base.en-q5_1 · downloaded ggml-base.en-q5_1.bin (1 MB) — one-time speech model download')
  assert.equal(fetches, 1)
  assert.equal(checkWhisperModel(undefined, { digest: true }).state, 'present')
  assert.equal(voiceInputEnabled(), false)
  assert.equal((await read()).split('\n')[0], 'Transcript · 00:00:02 · Whisper base.en-q5_1')
  assert.equal(fetches, 1)
  assert.equal(fixture.calls(), 1)
  const model = join(whisperModelsDir(), row.file)
  rmSync(model)
  await Promise.all([prepareLocalTranscriber(), prepareLocalTranscriber()])
  assert.equal(fetches, 2)
  writeFileSync(model, Buffer.alloc(payload.length, 8))
  await prepareLocalTranscriber()
  assert.equal(fetches, 3)
  assert.equal(checkWhisperModel(undefined, { digest: true }).state, 'present')
  for (const [bad, refusal] of [[Buffer.alloc(payload.length, 8), /does not match the lock digest/], [payload.subarray(0, 20), /ended at 20 of 4096 bytes/]] as const) {
    rmSync(model, { force: true })
    body = bad
    await assert.rejects(prepareLocalTranscriber(), refusal)
    assert.equal(existsSync(model), false)
    assert.equal(existsSync(`${model}.part`), false)
    assert.equal(voiceInputEnabled(), false)
  }
  httpStatus = 503
  await assert.rejects(prepareLocalTranscriber(), /HTTP 503/)
  assert.equal(existsSync(`${model}.part`), false)
  console.log('PASS media model setup: default first-use download under stub, digest and byte checks, reuse, shared preparation, repair and failures; dictation stays off')
} finally {
  globalThis.fetch = fetchBefore
  Object.assign(row, original)
  rmSync(root, { recursive: true, force: true })
}
