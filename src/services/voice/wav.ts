// ============================================================================
//  services/voice/wav — the ONE owner of the voice capture's audio shape.
//
//  Every capture backend (the vendored addon, a PATH recorder, the fixture)
//  hands the capture owner raw signed 16-bit little-endian samples at
//  16 kHz mono; this module turns them into the WAV the transcribers
//  accept, reads a WAV back (the fixture road and the provers), and answers
//  the two facts the receipts need — how long the capture ran and whether
//  anything but silence reached the microphone. Pure: node:buffer only, no
//  reads, no writes, no side effects.
// ============================================================================

/** The capture format every backend delivers: 16 kHz · mono · 16-bit PCM. */
export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_CHANNELS = 1
export const VOICE_BITS_PER_SAMPLE = 16

const RIFF_HEADER_BYTES = 44

/** Wrap s16le PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav(
  pcm: Buffer | Int16Array,
  opts: { sampleRate?: number; channels?: number } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? VOICE_SAMPLE_RATE
  const channels = opts.channels ?? VOICE_CHANNELS
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const blockAlign = (channels * VOICE_BITS_PER_SAMPLE) / 8
  const header = Buffer.alloc(RIFF_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(VOICE_BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

export interface WavHeader {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Byte offset of the first sample. */
  dataOffset: number
  /** Sample bytes (the data chunk's declared length, clamped to the file). */
  dataBytes: number
}

export type WavRead = { ok: true; header: WavHeader; pcm: Buffer } | { ok: false; reason: string }

/** Read a PCM WAV: the RIFF/WAVE/fmt /data chunks, tolerant of extra
 *  chunks between fmt and data (LIST, fact) and of a streamed data length
 *  (0 or 0xFFFFFFFF — clamped to the bytes present). */
export function readWav(buf: Buffer): WavRead {
  if (buf.length < RIFF_HEADER_BYTES) return { ok: false, reason: `too short for a WAV header (${buf.length} bytes)` }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'not a RIFF/WAVE file' }
  }
  let at = 12
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number; format: number } | null = null
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const declared = buf.readUInt32LE(at + 4)
    const bodyAt = at + 8
    if (id === 'fmt ') {
      if (bodyAt + 16 > buf.length) return { ok: false, reason: 'truncated fmt chunk' }
      fmt = {
        format: buf.readUInt16LE(bodyAt),
        channels: buf.readUInt16LE(bodyAt + 2),
        sampleRate: buf.readUInt32LE(bodyAt + 4),
        bitsPerSample: buf.readUInt16LE(bodyAt + 14),
      }
    } else if (id === 'data') {
      if (fmt === null) return { ok: false, reason: 'data chunk before fmt chunk' }
      if (fmt.format !== 1) return { ok: false, reason: `unsupported WAV format tag ${fmt.format} (PCM only)` }
      const available = buf.length - bodyAt
      const dataBytes = declared === 0 || declared === 0xffffffff || declared > available ? available : declared
      return {
        ok: true,
        header: { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, dataOffset: bodyAt, dataBytes },
        pcm: buf.subarray(bodyAt, bodyAt + dataBytes),
      }
    }
    // Chunks are word-aligned: an odd body carries one pad byte.
    at = bodyAt + declared + (declared % 2)
  }
  return { ok: false, reason: 'no data chunk' }
}

/** The capture format the transcribers are promised. */
export function isVoiceWavShape(header: WavHeader): boolean {
  return header.sampleRate === VOICE_SAMPLE_RATE && header.channels === VOICE_CHANNELS && header.bitsPerSample === VOICE_BITS_PER_SAMPLE
}

/** s16le bytes → samples (a copy when the bytes are not 2-aligned). */
export function pcmSamples(pcm: Buffer): Int16Array {
  if (pcm.byteOffset % 2 === 0 && pcm.byteLength % 2 === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
  }
  const even = pcm.subarray(0, pcm.byteLength - (pcm.byteLength % 2))
  const copy = Buffer.from(even)
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2)
}

export function pcmDurationMs(pcm: Buffer | Int16Array, sampleRate = VOICE_SAMPLE_RATE, channels = VOICE_CHANNELS): number {
  const samples = Buffer.isBuffer(pcm) ? Math.floor(pcm.byteLength / 2) : pcm.length
  return Math.round((samples / channels / sampleRate) * 1000)
}

/** Below this peak the capture carried nothing a transcriber could use:
 *  1/4096 of full scale is the noise floor of an unpowered input. */
export const SILENCE_PEAK = 8

/** True when no sample rose above the silence peak — the microphone road
 *  delivered a stream but nothing reached it (a denied permission on macOS
 *  produces exactly this: a live stream of zeros). */
export function pcmIsSilent(pcm: Buffer | Int16Array, peak = SILENCE_PEAK): boolean {
  const samples = Buffer.isBuffer(pcm) ? pcmSamples(pcm) : pcm
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number
    if (v > peak || v < -peak) return false
  }
  return true
}

/** A deterministic sine tone as a capture-shaped WAV — the fixture
 *  recorder's canned audio and the provers' known-good file; never a
 *  microphone. */
export function synthesizeToneWav(opts: { seconds?: number; hz?: number; amplitude?: number } = {}): Buffer {
  const seconds = opts.seconds ?? 1
  const hz = opts.hz ?? 440
  const amplitude = Math.min(1, Math.max(0, opts.amplitude ?? 0.25))
  const count = Math.round(seconds * VOICE_SAMPLE_RATE)
  const pcm = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / VOICE_SAMPLE_RATE) * amplitude * 32767)
  }
  return encodeWav(pcm)
}
