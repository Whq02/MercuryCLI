import type { Readable } from 'node:stream'
import { MAX_LINE_BYTES } from './wire.js'
import { MercuryWireError } from './errors.js'

export function readLines(stream: Readable, line: (value: string) => void, fail: (error: MercuryWireError) => void): void {
  let parts: Buffer[] = []
  let size = 0
  let failed = false
  const append = (part: Buffer): boolean => {
    if (size + part.length > MAX_LINE_BYTES) {
      failed = true
      const preview = Buffer.concat([...parts, part]).toString('utf8')
      parts = []; size = 0
      fail(new MercuryWireError(preview, 'invalid', undefined, [{ path: '', message: `line exceeds ${MAX_LINE_BYTES} bytes` }], null))
      return false
    }
    parts.push(part); size += part.length
    return true
  }
  const flush = () => {
    const value = Buffer.concat(parts, size).toString('utf8').replace(/^\uFEFF/, '')
    parts = []; size = 0
    line(value)
  }
  stream.on('data', (chunk: Buffer) => {
    if (failed) return
    let start = 0
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      if (!append(chunk.subarray(start, end))) return
      flush()
      start = end + 1
    }
    if (start < chunk.length) append(chunk.subarray(start))
  })
  stream.on('end', () => { if (!failed && size) flush() })
}
