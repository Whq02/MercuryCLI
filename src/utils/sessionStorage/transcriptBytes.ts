import { closeSync, openSync, readSync, statSync } from 'node:fs'

interface TranscriptReaderIo {
  statSync(path: string): { size: number; ino: number } | null
  readRangeSync(path: string, start: number, end: number): Buffer
}

export const nodeTranscriptReaderIo: TranscriptReaderIo = {
  statSync(path) {
    try {
      const st = statSync(path)
      return { size: st.size, ino: st.ino }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw e
    }
  },
  readRangeSync(path, start, end) {
    const len = Math.max(0, end - start)
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(path, 'r')
    try {
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read)
        if (n === 0) break
        read += n
      }
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  },
}

export let transcriptIo: TranscriptReaderIo = nodeTranscriptReaderIo

export function setTranscriptReaderIoForTesting(next: TranscriptReaderIo | null): void {
  transcriptIo = next ?? nodeTranscriptReaderIo
}

export const transcriptReaderCensus = {
  coldReads: 0,
  growthReads: 0,
  resets: 0,
  bytesRead: 0,
  chainDerivations: 0,
}

interface TranscriptByteCursor {
  offset: number
  carry: string
}

interface TranscriptBytesAfter {
  text: string
  cursor: TranscriptByteCursor
  rewound: boolean
  size: number
}

export function readTranscriptBytesAfter(path: string, cursor: TranscriptByteCursor): TranscriptBytesAfter {
  const st = transcriptIo.statSync(path)
  if (st === null) return { text: '', cursor: { offset: 0, carry: '' }, rewound: cursor.offset > 0, size: 0 }
  let from = cursor.offset
  let carry = cursor.carry
  let rewound = false
  if (st.size < cursor.offset) {
    from = 0
    carry = ''
    rewound = true
  }
  if (st.size === from) return { text: '', cursor: { offset: from, carry }, rewound, size: st.size }
  const buf = transcriptIo.readRangeSync(path, from, st.size)
  transcriptReaderCensus.bytesRead += buf.length
  const combined = carry + buf.toString('utf8')
  const lastNewline = combined.lastIndexOf('\n')
  return {
    text: lastNewline === -1 ? '' : combined.slice(0, lastNewline),
    cursor: { offset: from + buf.length, carry: lastNewline === -1 ? combined : combined.slice(lastNewline + 1) },
    rewound,
    size: st.size,
  }
}

export function* transcriptLineBytes(
  path: string,
  { start = 0, end = transcriptIo.statSync(path)?.size ?? 0, pieceBytes = 256 * 1024 } = {},
): Generator<Buffer> {
  if (!Number.isSafeInteger(pieceBytes) || pieceBytes < 1) throw new RangeError('pieceBytes must be a positive integer')
  let pending: Buffer[] = []
  for (let from = start; from < end;) {
    const to = Math.min(from + pieceBytes, end)
    const chunk = transcriptIo.readRangeSync(path, from, to)
    transcriptReaderCensus.bytesRead += chunk.length
    if (chunk.length !== to - from) throw new Error('Transcript changed during the read')
    from = to
    let at = 0
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, at)) {
      const part = chunk.subarray(at, nl + 1)
      if (pending.length === 0) yield part
      else {
        pending.push(part)
        yield Buffer.concat(pending)
        pending = []
      }
      at = nl + 1
    }
    if (at < chunk.length) pending.push(chunk.subarray(at))
  }
  if (pending.length > 0) yield pending.length === 1 ? pending[0]! : Buffer.concat(pending)
}
