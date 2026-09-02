import { Buffer } from 'buffer'


function leadLength(b: number): number {
  if (b >= 0xf0) return 4
  if (b >= 0xe0) return 3
  if (b >= 0xc0) return 2
  return 1
}

export function splitDecodableHead(buf: Buffer): { text: string; pending: Buffer | undefined } {
  const len = buf.length
  let i = len - 1
  let back = 0
  while (i >= 0 && back < 4) {
    const b = buf[i]!
    if (b < 0x80) break
    if (b >= 0xc0) {
      if (leadLength(b) > len - i) {
        return {
          text: buf.subarray(0, i).toString('utf8'),
          pending: Buffer.from(buf.subarray(i)),
        }
      }
      break
    }
    i--
    back++
  }
  return { text: buf.toString('utf8'), pending: undefined }
}

export function decodeChunk(
  pending: Buffer | undefined,
  input: Buffer | string | null,
): { text: string; pending: Buffer | undefined } {
  if (input === null) {
    return { text: pending?.length ? pending.toString('utf8') : '', pending: undefined }
  }
  if (Buffer.isBuffer(input)) {
    const combined = pending?.length ? Buffer.concat([pending, input]) : input
    return splitDecodableHead(combined)
  }
  const prefix = pending?.length ? pending.toString('utf8') : ''
  return { text: prefix + input, pending: undefined }
}
