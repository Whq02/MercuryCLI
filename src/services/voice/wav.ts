
export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_CHANNELS = 1
export const VOICE_BITS_PER_SAMPLE = 16

const RIFF_HEADER_BYTES = 44

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
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
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
  dataOffset: number
  dataBytes: number
}

export type WavRead = { ok: true; header: WavHeader; pcm: Buffer } | { ok: false; reason: string }

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
    at = bodyAt + declared + (declared % 2)
  }
  return { ok: false, reason: 'no data chunk' }
}

export function isVoiceWavShape(header: WavHeader): boolean {
  return header.sampleRate === VOICE_SAMPLE_RATE && header.channels === VOICE_CHANNELS && header.bitsPerSample === VOICE_BITS_PER_SAMPLE
}

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

export const SILENCE_PEAK = 8

export function pcmIsSilent(pcm: Buffer | Int16Array, peak = SILENCE_PEAK): boolean {
  const samples = Buffer.isBuffer(pcm) ? pcmSamples(pcm) : pcm
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number
    if (v > peak || v < -peak) return false
  }
  return true
}

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
