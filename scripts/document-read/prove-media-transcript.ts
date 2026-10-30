import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localFixture } from '../voice/localFixture.ts'
import { encodeWav, readWav } from '../../src/services/voice/wav.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'media-read-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const fixture = localFixture(join(root, 'whisper'), 'The lighthouse guides seven ships.')
Object.assign(process.env, fixture.env)
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { mediaFileFormat, mediaDecoderMissing, extractMediaTranscript } = await import('../../src/services/voice/fileTranscript.ts')
const { getToolResultsDir } = await import('../../src/utils/toolResultStorage.ts')
const { localDecodesInFlight } = await import('../../src/services/voice/transcribe.ts')
const context = { options: { engineModel: 'glm-5.3' }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
async function read(input: object) {
  const valid = await FileReadTool.validateInput(input as never, context as never)
  assert.equal(valid.result, true, 'message' in valid ? valid.message : '')
  const result = await FileReadTool.call(input as never, context as never, undefined, { uuid: crypto.randomUUID() } as never)
  assert.equal(result.data.type, 'text')
  const block = FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'read-media')
  return { data: result.data as Extract<typeof result.data, { type: 'text' }>, text: String(block.content) }
}
const originalPath = process.env.PATH
try {
  const source = fileURLToPath(new URL('../voice/fixtures/on-device-take.wav', import.meta.url))
  const wav = readWav(readFileSync(source))
  assert.ok(wav.ok)
  assert.ok(wav.header.dataBytes / 32000 < 10)
  const path = join(root, 'speech.wav')
  copyFileSync(source, path)
  process.env.PATH = ''
  const first = await read({ file_path: path, offset: 1, limit: 1 })
  assert.equal(first.data.file.content, 'Transcript · 00:00:02 · Whisper fixture.en')
  assert.match(first.text, /^1\tTranscript/)
  assert.match(first.text, /Read\(offset: 2, limit: 1\) continues from there/)
  assert.equal(fixture.calls(), 1)
  const second = await read({ file_path: path, offset: 2, limit: 1 })
  assert.match(second.text, /^2\t\[00:00:00\] The lighthouse guides seven ships\./)
  assert.match(second.text, /the end of the file/)
  assert.equal(fixture.calls(), 1)
  assert.equal(context.readFileState.has(path), false)
  const tail = await read({ file_path: path, offset: -1 })
  assert.equal(tail.data.file.content, second.data.file.content)
  const ranges = await read({ file_path: path, ranges: ['2', '1'] })
  assert.match(ranges.text, /^2\t\[00:00:00\]/)
  assert.match(ranges.text, /\n\n1\tTranscript/)
  const renamed = join(root, 'speech.bin')
  copyFileSync(source, renamed)
  assert.match((await read({ file_path: renamed })).text, /\[00:00:00\] The lighthouse/)
  assert.equal(fixture.calls(), 1)
  const info = statSync(path)
  const modified = readFileSync(source)
  modified[modified.length - 2] = modified[modified.length - 2]! ^ 1
  writeFileSync(path, modified)
  utimesSync(path, info.atime, info.mtime)
  await read({ file_path: path })
  assert.equal(fixture.calls(), 2)
  const long = join(root, 'long.wav')
  const pcm = Buffer.alloc(31 * 32000)
  for (let at = 0; at < pcm.length; at += wav.pcm.length) wav.pcm.copy(pcm, at)
  writeFileSync(long, encodeWav(pcm))
  const chunked = await read({ file_path: long })
  assert.match(chunked.text, /^1\tTranscript · 00:00:31/)
  assert.match(chunked.text, /2\t\[00:00:00\].*\n3\t\[00:00:30\]/)
  assert.equal(fixture.calls(), 4)
  assert.deepEqual(readFileSync(fixture.ledger, 'utf8').trim().split('\n').slice(-2), ['decode 960000', 'decode 32000'])
  await read({ file_path: long })
  assert.equal(fixture.calls(), 4)
  const otherModel = join(root, 'ggml-other.en.bin')
  writeFileSync(otherModel, 'another fixture model')
  process.env.MERCURY_WHISPER_MODEL = otherModel
  assert.match((await read({ file_path: long })).text, /Whisper other.en/)
  assert.equal(fixture.calls(), 6)
  process.env.MERCURY_WHISPER_MODEL = fixture.env.MERCURY_WHISPER_MODEL
  for (const ext of ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov', 'mkv']) {
    const media = join(root, `decoder.${ext}`)
    writeFileSync(media, 'fixture encoded audio')
    assert.equal(mediaFileFormat(media), ext)
    await assert.rejects(read({ file_path: media }), error => error instanceof Error && error.message === mediaDecoderMissing(ext))
  }
  for (const [platform, command] of [['darwin', 'brew install ffmpeg'], ['linux', 'apt install ffmpeg'], ['win32', 'winget install ffmpeg']]) {
    assert.equal(mediaDecoderMissing('mp4', platform), `This MP4 file needs the ffmpeg audio decoder; install it with \`${command}\`.`)
  }
  const extended = join(root, 'extended.wav')
  const classic = encodeWav(wav.pcm)
  const extension = Buffer.alloc(24)
  extension.writeUInt16LE(22, 0)
  extension.writeUInt16LE(16, 2)
  Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(extension, 8)
  const extensible = Buffer.concat([classic.subarray(0, 36), extension, classic.subarray(36)])
  extensible.writeUInt32LE(extensible.length - 8, 4)
  extensible.writeUInt32LE(40, 16)
  extensible.writeUInt16LE(0xfffe, 20)
  writeFileSync(extended, extensible)
  assert.match((await read({ file_path: extended })).text, /\[00:00:00\] The lighthouse/)
  const signatures = [
    ['flac', Buffer.from('fLaC')], ['ogg', Buffer.from('OggS')], ['mp3', Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])],
    ['mp4', Buffer.from('0000ftypisom')], ['m4a', Buffer.from('0000ftypM4A ')], ['mov', Buffer.from('0000ftypqt  ')],
    ['mkv', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])], ['aac', Buffer.from([0xff, 0xf1, 0x50, 0x80])], ['mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00])],
  ] as const
  for (const [format, bytes] of signatures) {
    const target = join(root, 'unknown')
    writeFileSync(target, bytes)
    assert.equal(mediaFileFormat(target), format)
  }
  writeFileSync(join(root, 'photo'), Buffer.from('0000ftypavif'))
  assert.equal(mediaFileFormat(join(root, 'photo')), null)
  const stereo = join(root, 'stereo.wav')
  writeFileSync(stereo, encodeWav(wav.pcm, { sampleRate: 44100, channels: 2 }))
  await assert.rejects(read({ file_path: stereo }), error => error instanceof Error && error.message === mediaDecoderMissing('wav'))
  const executable = join(root, 'binary.exe')
  writeFileSync(executable, Buffer.from([0x4d, 0x5a, 0, 0]))
  await assert.rejects(read({ file_path: executable }), /cannot read binary files/)
  const controller = new AbortController()
  const abortPath = join(root, 'abort.wav')
  writeFileSync(abortPath, encodeWav(Buffer.alloc(31 * 32000, 1)))
  const cacheCount = readdirSync(getToolResultsDir()).length
  let decodes = 0
  await assert.rejects(extractMediaTranscript(abortPath, 'wav', controller.signal, async () => {
    decodes++
    controller.abort()
    return { text: 'first', model: 'fixture.en', ms: 0, kind: 'local', family: null, segments: [{ text: 'first', startMs: 0, endMs: 1000 }] }
  }))
  assert.equal(decodes, 1)
  assert.equal(readdirSync(getToolResultsDir()).length, cacheCount)
  assert.equal(localDecodesInFlight(), 0)
  console.log('PASS media Read: timestamped lines, windows, ranges, tail, digest cache, model choice, bounded chunks, sniffing, missing decoder and cancellation')
} finally {
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}
