import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync } from 'node:fs'
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { spawnFfmpeg, ffmpegInstallCommand } from '../../utils/ffmpeg.js'
import { ensureToolResultsDir, getToolResultsDir } from '../../utils/toolResultStorage.js'
import { prepareLocalTranscriber, transcribeWav } from './transcribe.js'
import { mbWords, resolveWhisperModelPin } from './whisperModels.js'
import { encodeWav, VOICE_SAMPLE_RATE } from './wav.js'
import type { WhisperSegment } from './whisperPack.js'

const MEDIA_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov', 'mkv'])
const PCM_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2
const WINDOW_BYTES = 30 * PCM_BYTES_PER_SECOND

export function mediaFileFormat(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) return null
    const header = Buffer.alloc(64)
    const length = readSync(fd, header, 0, header.length, 0)
    const ascii = (start: number, end: number) => header.toString('ascii', start, Math.min(end, length))
    if (length >= 12 && ['RIFF', 'RF64'].includes(ascii(0, 4)) && ascii(8, 12) === 'WAVE') return 'wav'
    if (ascii(0, 4) === 'fLaC') return 'flac'
    if (ascii(0, 4) === 'OggS') return header.subarray(0, length).includes(Buffer.from('OpusHead')) ? 'opus' : 'ogg'
    if (length >= 12 && ascii(4, 8) === 'ftyp') {
      const brand = ascii(8, 12)
      if (/^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return null
      return brand === 'qt  ' ? 'mov' : brand.startsWith('M4A') ? 'm4a' : 'mp4'
    }
    if (length >= 4 && header.readUInt32BE(0) === 0x1a45dfa3) return header.subarray(0, length).includes(Buffer.from('webm')) ? 'webm' : 'mkv'
    if (length >= 10 && ascii(0, 3) === 'ID3' && header[3]! >= 2 && header[3]! <= 4 && header.subarray(6, 10).every(byte => byte < 128)) return 'mp3'
    const ext = extname(path).slice(1).toLowerCase()
    if (length >= 2 && ((header[0] === 0xff && header[1] === 0xfe) || (header[0] === 0xfe && header[1] === 0xff))) return null
    if (length >= 4 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0) {
      if ((header[1]! & 0xf6) === 0xf0) return 'aac'
      if ((header[1]! & 6) !== 0 && (header[2]! & 0xf0) !== 0xf0 && (header[2]! & 0x0c) !== 0x0c) return 'mp3'
    }
    return MEDIA_EXTENSIONS.has(ext) ? ext : null
  } finally { closeSync(fd) }
}

async function digestFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function directWavRange(path: string, signal: AbortSignal): Promise<{ start: number; bytes: number } | null> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const header = Buffer.alloc(40)
    if ((await file.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null
    let pcm = false
    let at = 12
    while (at + 8 <= size) {
      signal.throwIfAborted()
      if ((await file.read(header, 0, 8, at)).bytesRead !== 8) return null
      const id = header.toString('ascii', 0, 4)
      const bytes = header.readUInt32LE(4)
      const start = at + 8
      if (start + bytes > size) return null
      if (id === 'fmt ') {
        const take = Math.min(bytes, header.length)
        if (take < 16 || (await file.read(header, 0, take, start)).bytesRead !== take) return null
        const format = header.readUInt16LE(0)
        const integerPcm = format === 1 || (format === 0xfffe && take === 40 && header.readUInt16LE(16) >= 22 && header.readUInt16LE(18) === 16 && header.subarray(24, 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex')))
        pcm = integerPcm && header.readUInt16LE(2) === 1 && header.readUInt32LE(4) === VOICE_SAMPLE_RATE && header.readUInt16LE(12) === 2 && header.readUInt16LE(14) === 16
      } else if (id === 'data') {
        return pcm && bytes % 2 === 0 ? { start, bytes } : null
      }
      at = start + bytes + bytes % 2
    }
    return null
  } finally { await file.close() }
}

export function mediaDecoderMissing(format: string, platform: string = process.platform): string {
  return `This ${format.toUpperCase()} file needs the ffmpeg audio decoder; install it with \`${ffmpegInstallCommand(platform)}\`.`
}

async function* decodedPcm(path: string, format: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const direct = await directWavRange(path, signal)
  if (direct !== null) {
    if (direct.bytes > 0) yield* createReadStream(path, { start: direct.start, end: direct.start + direct.bytes - 1, signal })
    return
  }
  const child = spawnFfmpeg(['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,matroska,webm,aac,flac,ogg', '-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(VOICE_SAMPLE_RATE), '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'], signal)
  child.stderr.resume()
  let closed = false
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', error => reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? mediaDecoderMissing(format) : `The ${format.toUpperCase()} audio decoder could not start; check that ffmpeg runs from your terminal.`)))
    child.once('close', code => {
      closed = true
      if (code === 0) resolve()
      else reject(new Error(`Cannot decode the audio in this ${format.toUpperCase()} file with ffmpeg; check that it contains a playable audio track.`))
    })
  })
  void ended.catch(() => {})
  try {
    yield* child.stdout
    await ended
  } catch (error) {
    if (!signal.aborted) await ended
    throw error
  } finally {
    if (!closed) {
      const stopped = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill('SIGKILL')
      await stopped
    }
  }
}

async function* pcmWindows(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let window = Buffer.allocUnsafe(WINDOW_BYTES)
  let used = 0
  for await (const chunk of chunks) {
    let at = 0
    while (at < chunk.length) {
      const take = Math.min(WINDOW_BYTES - used, chunk.length - at)
      chunk.copy(window, used, at, at + take)
      used += take
      at += take
      if (used === WINDOW_BYTES) {
        yield window
        window = Buffer.allocUnsafe(WINDOW_BYTES)
        used = 0
      }
    }
  }
  if (used % 2 !== 0) throw new Error('The decoded audio ends with an incomplete PCM sample; export the file again.')
  if (used) yield window.subarray(0, used)
}

function timestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(part => String(part).padStart(2, '0')).join(':')
}

type MediaTranscript = { durationMs: number; model: string; segments: WhisperSegment[] }

function isTranscript(value: unknown): value is MediaTranscript {
  if (!value || typeof value !== 'object') return false
  const row = value as MediaTranscript
  return Number.isFinite(row.durationMs) && row.durationMs >= 0 && typeof row.model === 'string' && Array.isArray(row.segments) && row.segments.every(segment => typeof segment?.text === 'string' && Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.startMs >= 0 && segment.endMs >= segment.startMs && segment.endMs <= row.durationMs)
}

function renderTranscript(result: MediaTranscript, downloaded?: { file: string; bytes: number }): string {
  const download = downloaded ? ` · downloaded ${downloaded.file} (${mbWords(downloaded.bytes)}) — one-time speech model download` : ''
  return [`Transcript · ${timestamp(result.durationMs)} · Whisper ${result.model}${download}`, ...result.segments.map(segment => `[${timestamp(segment.startMs)}] ${segment.text}`), ...(result.segments.length ? [] : ['No speech found.'])].join('\n')
}

export async function extractMediaTranscript(path: string, format: string, signal: AbortSignal, decode: typeof transcribeWav = transcribeWav): Promise<string> {
  signal.throwIfAborted()
  const before = await stat(path)
  if (!before.isFile()) throw new Error(`${path}: not a regular file.`)
  const pin = resolveWhisperModelPin()
  if (pin.kind === 'broken') throw new Error(pin.note)
  const modelDigest = pin.kind === 'catalogue' ? pin.row.sha256 : await digestFile(pin.path, signal)
  const sourceDigest = await digestFile(path, signal)
  const key = createHash('sha256').update(JSON.stringify([sourceDigest, modelDigest, pin.kind === 'catalogue' ? pin.row.name : pin.name])).digest('hex')
  const cached = join(getToolResultsDir(), `media-transcript-v1-${key}.json`)
  const unchanged = async () => {
    const after = await stat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('The media file changed during transcription; Read it again.')
    signal.throwIfAborted()
  }
  let stored: unknown
  try { stored = JSON.parse(await readFile(cached, 'utf8')) } catch {}
  if (isTranscript(stored)) {
    await unchanged()
    return renderTranscript(stored)
  }
  let prepared: Awaited<ReturnType<typeof prepareLocalTranscriber>> | undefined
  const segments: WhisperSegment[] = []
  let bytes = 0
  for await (const pcm of pcmWindows(decodedPcm(path, format, signal))) {
    signal.throwIfAborted()
    prepared ??= await prepareLocalTranscriber()
    signal.throwIfAborted()
    const answer = await decode(encodeWav(pcm), { choice: { kind: 'local', label: prepared.local.label, model: prepared.local.model }, signal })
    if (answer.model !== prepared.local.model) throw new Error('The speech model changed during transcription; Read the file again.')
    if (!answer.segments) throw new Error('The Whisper driver has no segment timestamps; update Mercury or rebuild it with `bun run scripts/vendor/build-whisper.ts`.')
    const start = bytes / PCM_BYTES_PER_SECOND * 1000
    const duration = pcm.length / PCM_BYTES_PER_SECOND * 1000
    for (const segment of answer.segments) {
      const text = segment.text.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
      if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs) throw new Error('Whisper returned invalid segment times; Read the file again.')
      if (text && segment.startMs < duration) segments.push({ text, startMs: start + segment.startMs, endMs: start + Math.min(segment.endMs, duration) })
    }
    bytes += pcm.length
  }
  signal.throwIfAborted()
  if (!prepared) throw new Error('This media file contains no audio samples to transcribe.')
  await unchanged()
  const result: MediaTranscript = { durationMs: bytes / PCM_BYTES_PER_SECOND * 1000, model: prepared.local.model, segments }
  await ensureToolResultsDir()
  const stage = `${cached}.${randomUUID()}`
  try {
    await writeFile(stage, JSON.stringify(result), { mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(stage, cached)
  } finally { await rm(stage, { force: true }) }
  return renderTranscript(result, prepared.downloaded)
}
