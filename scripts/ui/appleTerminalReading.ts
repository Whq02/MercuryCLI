import { readFileSync, writeFileSync } from 'node:fs'

const SGR = /\x1b\[([0-9;]*)m/g

export type ColorSgr = { kind: '24-bit' | '256'; params: number[] }

export function readAppleTerminalParams(params: number[]): number[] {
  const out: number[] = []
  let i = 0
  while (i < params.length) {
    const v = params[i]!
    if (v === 38 || v === 48 || v === 58) {
      if (params[i + 1] === 5 && i + 2 < params.length) {
        out.push(v, 5, params[i + 2]!)
        i += 3
        continue
      }
      i += 1
      continue
    }
    out.push(v)
    i += 1
  }
  return out
}

function paramsOf(text: string): number[] {
  return text.length === 0 ? [0] : text.split(';').map(p => (p === '' ? 0 : Number(p)))
}

export function applyAppleTerminalReading(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1')
  const read = text.replace(SGR, (whole, raw: string) => {
    const params = paramsOf(raw)
    const seen = readAppleTerminalParams(params)
    if (seen.length === params.length && seen.every((p, i) => p === params[i])) return whole
    return `\x1b[${seen.join(';')}m`
  })
  return Buffer.from(read, 'latin1')
}

export function colorSgrSequences(bytes: Uint8Array): ColorSgr[] {
  const text = Buffer.from(bytes).toString('latin1')
  const found: ColorSgr[] = []
  for (const m of text.matchAll(SGR)) {
    const params = paramsOf(m[1] ?? '')
    for (let i = 0; i < params.length; i++) {
      const v = params[i]
      if (v !== 38 && v !== 48) continue
      if (params[i + 1] === 2 && i + 4 < params.length) {
        found.push({ kind: '24-bit', params: params.slice(i, i + 5) })
        i += 4
      } else if (params[i + 1] === 5 && i + 2 < params.length) {
        found.push({ kind: '256', params: params.slice(i, i + 3) })
        i += 2
      }
    }
  }
  return found
}

export function readTeeFrames(bytes: Uint8Array): Array<{ tick: number; data: Uint8Array }> {
  const buf = Buffer.from(bytes)
  const frames: Array<{ tick: number; data: Uint8Array }> = []
  let off = 0
  while (off + 8 <= buf.length) {
    const tick = buf.readUInt32BE(off)
    const len = buf.readUInt32BE(off + 4)
    off += 8
    frames.push({ tick, data: buf.subarray(off, off + len) })
    off += len
  }
  return frames
}

export function teeBytes(bytes: Uint8Array): Uint8Array {
  return Buffer.concat(readTeeFrames(bytes).map(f => Buffer.from(f.data)))
}

export function readTeeAsAppleTerminal(bytes: Uint8Array): Uint8Array {
  const parts: Buffer[] = []
  for (const frame of readTeeFrames(bytes)) {
    const read = Buffer.from(applyAppleTerminalReading(frame.data))
    const head = Buffer.alloc(8)
    head.writeUInt32BE(frame.tick, 0)
    head.writeUInt32BE(read.length, 4)
    parts.push(head, read)
  }
  return Buffer.concat(parts)
}

if (import.meta.main) {
  const at = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const input = at('--in')
  const output = at('--out')
  if (!input || !output) {
    console.error('usage: appleTerminalReading.ts --in <tee> --out <tee>')
    process.exit(2)
  }
  writeFileSync(output, readTeeAsAppleTerminal(readFileSync(input)))
}
