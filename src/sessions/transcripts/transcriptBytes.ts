import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

interface TranscriptReaderIo {
  statSync(path: string): { size: number; ino: number } | null
  readRangeSync(path: string, start: number, end: number): Buffer
}

export function rangeFromFd(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start))
  let read = 0
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, start + read)
    if (n === 0) break
    read += n
  }
  return buf.subarray(0, read)
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
    const fd = openSync(path, 'r')
    try {
      return rangeFromFd(fd, start, end)
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

export function* transcriptLineBytes(
  path: string,
  { start = 0, end = transcriptIo.statSync(path)?.size ?? 0, pieceBytes = 256 * 1024, ino = 0, opened = -1 } = {},
): Generator<Buffer> {
  if (!Number.isSafeInteger(pieceBytes) || pieceBytes < 1) throw new RangeError('pieceBytes must be a positive integer')
  if (start >= end) return
  const fd = opened >= 0 ? opened : transcriptIo === nodeTranscriptReaderIo ? openSync(path, 'r') : undefined
  try {
    if (fd !== undefined && ino && fstatSync(fd).ino !== ino) throw new Error(`History changed during the read: ${path}`)
    let pending: Buffer[] = []
    for (let from = start; from < end;) {
      const to = Math.min(from + pieceBytes, end)
      const chunk = fd === undefined ? transcriptIo.readRangeSync(path, from, to) : rangeFromFd(fd, from, to)
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
  } finally {
    if (fd !== undefined && opened < 0) closeSync(fd)
  }
}

export function* transcriptLinesInReverse(path: string, start: number, end: number, opened?: number): Generator<Buffer> {
  if (end <= start) return
  const fd = opened ?? (transcriptIo === nodeTranscriptReaderIo ? openSync(path, 'r') : undefined)
  let pending: Buffer[] = []
  try {
    for (let to = end; to > start;) {
      const from = Math.max(start, to - 64 * 1024)
      const chunk = fd === undefined ? transcriptIo.readRangeSync(path, from, to) : rangeFromFd(fd, from, to)
      transcriptReaderCensus.bytesRead += chunk.length
      if (chunk.length !== to - from) throw new Error(`History changed during the read: ${path}`)
      let right = chunk.length
      for (let nl = chunk.lastIndexOf(10); nl >= 0; nl = nl === 0 ? -1 : chunk.lastIndexOf(10, nl - 1)) {
        const endOfLine = chunk.subarray(nl + 1, right)
        if (endOfLine.length || pending.length) {
          if (pending.length === 0) yield endOfLine
          else { pending.push(endOfLine); yield Buffer.concat(pending.reverse()); pending = [] }
        }
        right = nl + 1
      }
      if (right) pending.push(chunk.subarray(0, right))
      to = from
    }
    if (pending.length) yield pending.length === 1 ? pending[0]! : Buffer.concat(pending.reverse())
  } finally { if (opened === undefined && fd !== undefined) closeSync(fd) }
}
