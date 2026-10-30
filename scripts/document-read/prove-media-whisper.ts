import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'media-whisper-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const source = fileURLToPath(new URL('../voice/fixtures/on-device-take.wav', import.meta.url))
const model = fileURLToPath(new URL('../../vendor/whisper-models/ggml-base.en-q5_1.bin', import.meta.url))
process.env.MERCURY_WHISPER_MODEL = model
const fetchBefore = globalThis.fetch
globalThis.fetch = (() => { throw new Error('The local-media proof must not fetch the network.') }) as typeof fetch
const { loadWhisperAddon } = await import('../../src/services/voice/whisperPack.ts')
const { extractMediaTranscript, mediaFileFormat } = await import('../../src/services/voice/fileTranscript.ts')
const { transcribeWav, unloadLocalModels } = await import('../../src/services/voice/transcribe.ts')
const { readWav } = await import('../../src/services/voice/wav.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
try {
  const load = loadWhisperAddon()
  if (!existsSync(source) || !existsSync(model) || load.state !== 'ok') {
    console.log(`SKIP real Whisper media: ${!existsSync(source) ? 'speech fixture absent' : !existsSync(model) ? 'offline base.en-q5_1 model absent' : load.state === 'unavailable' ? load.note : 'driver absent'}`)
  } else {
    const wav = readWav(readFileSync(source))
    assert.ok(wav.ok)
    assert.ok(wav.header.dataBytes / 32000 < 10)
    const signal = new AbortController().signal
    let decodes = 0
    const cpu: typeof transcribeWav = async (bytes, options) => {
      decodes++
      return transcribeWav(bytes, { ...options, useGpu: false })
    }
    const started = Date.now()
    const text = await extractMediaTranscript(source, 'wav', signal, cpu)
    assert.equal(text.split('\n')[0], 'Transcript · 00:00:02 · Whisper base.en-q5_1')
    assert.match(text, /\[00:00:0[0-2]\]/)
    assert.ok(['lighthouse', 'seven', 'ships'].filter(word => text.toLowerCase().includes(word)).length >= 2, text)
    assert.equal(decodes, 1)
    assert.equal(await extractMediaTranscript(source, 'wav', signal, cpu), text)
    assert.equal(decodes, 1)
    const context = { options: { engineModel: 'glm-5.3' }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
    const read = await FileReadTool.call({ file_path: source, offset: 2, limit: 1 }, context as never)
    assert.equal(read.data.type, 'text')
    assert.match(String(FileReadTool.mapToolResultToToolResultBlockParam(read.data, 'real-media').content), /^2\t\[00:00:0[0-2]\]/)
    console.log(`PASS real CPU Whisper (${Date.now() - started} ms): ${text.replace(/\n/g, ' | ')}`)
    const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true })
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      console.log('SKIP encoded media: ffmpeg is not on PATH')
    } else {
      assert.equal(probe.status, 0, probe.stderr)
      for (const [extension, args] of [
        ['m4a', ['-i', source, '-c:a', 'aac']],
        ['mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1', '-i', source, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest']],
      ] as const) {
        const encoded = join(root, `speech.${extension}`)
        const exportResult = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, encoded], { encoding: 'utf8', windowsHide: true })
        assert.equal(exportResult.status, 0, exportResult.stderr)
        const format = mediaFileFormat(encoded)
        assert.ok(format)
        const decoded = await extractMediaTranscript(encoded, format, signal, cpu)
        assert.match(decoded, /\[00:00:0[0-2]\]/)
        assert.ok(['lighthouse', 'seven', 'ships'].filter(word => decoded.toLowerCase().includes(word)).length >= 2, decoded)
        console.log(`PASS ${extension} through ffmpeg and CPU Whisper: ${decoded.replace(/\n/g, ' | ')}`)
      }
      const malformed = join(root, 'broken.mp4')
      writeFileSync(malformed, 'not encoded media')
      await assert.rejects(extractMediaTranscript(malformed, 'mp4', signal, cpu), /Cannot decode the audio in this MP4 file/)
      const playlist = join(root, 'playlist.mp4')
      let requests = 0
      const server = createServer((_request, response) => { requests++; response.end() })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/speech.ts\n#EXT-X-ENDLIST\n`)
        await assert.rejects(extractMediaTranscript(playlist, 'mp4', signal, cpu), /Cannot decode the audio in this MP4 file/)
        assert.equal(requests, 0)
      } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
      console.log('PASS malformed media and a disguised network playlist are refused')
    }
  }
} finally {
  globalThis.fetch = fetchBefore
  unloadLocalModels()
  rmSync(root, { recursive: true, force: true })
}
