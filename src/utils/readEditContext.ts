import { open, type FileHandle } from 'node:fs/promises'

import { isENOENT } from './errors.js'

export const CHUNK_SIZE = 8 * 1024

const MAX_SCAN_BYTES = 10 * 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024

type EditContext = {
  content: string
  lineOffset: number
  truncated: boolean
}

export async function openForScan(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r')
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}

async function readSpan(
  handle: FileHandle,
  start: number,
  maxBytes: number,
): Promise<{ buffer: Buffer; reachedEof: boolean }> {
  if (maxBytes <= 0) return { buffer: Buffer.alloc(0), reachedEof: false }
  const out = Buffer.allocUnsafe(maxBytes)
  let collected = 0
  while (collected < maxBytes) {
    const { bytesRead } = await handle.read(out, collected, maxBytes - collected, start + collected)
    if (bytesRead === 0) break
    collected += bytesRead
  }
  return { buffer: out.subarray(0, collected), reachedEof: collected < maxBytes }
}

function findEarliestMatch(
  buf: Buffer,
  needles: readonly Buffer[],
): { index: number; matched: Buffer } | null {
  let bestIndex = -1
  let bestNeedle: Buffer | null = null
  for (const needle of needles) {
    const idx = buf.indexOf(needle)
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx
      bestNeedle = needle
    }
  }
  return bestNeedle === null ? null : { index: bestIndex, matched: bestNeedle }
}

function countNewlines(buf: Buffer, end: number): number {
  let count = 0
  for (let i = 0; i < end; i++) {
    if (buf[i] === 10) count++
  }
  return count
}

function trimLeadingUtf8Continuation(buf: Buffer): Buffer {
  let start = 0
  const limit = Math.min(buf.length, 3)
  while (start < limit && (buf[start]! & 0xc0) === 0x80) {
    start++
  }
  return start === 0 ? buf : buf.subarray(start)
}

function trimTrailingIncompleteUtf8(buf: Buffer): Buffer {
  if (buf.length === 0) return buf
  const floor = Math.max(0, buf.length - 4)
  let pos = buf.length - 1
  while (pos > floor && (buf[pos]! & 0xc0) === 0x80) {
    pos--
  }
  const lead = buf[pos]!
  let expected = 1
  if ((lead & 0x80) === 0) expected = 1
  else if ((lead & 0xe0) === 0xc0) expected = 2
  else if ((lead & 0xf0) === 0xe0) expected = 3
  else if ((lead & 0xf8) === 0xf0) expected = 4
  else return buf.subarray(0, pos)
  return buf.length - pos < expected ? buf.subarray(0, pos) : buf
}

export async function scanForContext(handle: FileHandle, needle: string, contextLines: number): Promise<EditContext> {
  if (needle.length === 0) return { content: '', lineOffset: 1, truncated: false }
  const lfBuf = Buffer.from(needle, 'utf8')
  const crlfNeedle = needle.includes('\n') ? needle.replace(/(?<!\r)\n/g, '\r\n') : needle
  const needles = crlfNeedle !== needle ? [lfBuf, Buffer.from(crlfNeedle, 'utf8')] : [lfBuf]
  const maxNeedleLen = needles.reduce((acc, item) => Math.max(acc, item.length), 0)

  let newlinesBeforeCarry = 0
  let position = 0
  let carry = Buffer.alloc(0)
  let matchByte = -1
  let matchedBuf: Buffer | null = null
  let newlinesBeforeMatch = 0
  const readBuf = Buffer.allocUnsafe(CHUNK_SIZE)

  while (position < MAX_SCAN_BYTES) {
    const toRead = Math.min(CHUNK_SIZE, MAX_SCAN_BYTES - position)
    const { bytesRead } = await handle.read(readBuf, 0, toRead, position)
    if (bytesRead === 0) break
    const chunk = readBuf.subarray(0, bytesRead)
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
    const bufStart = position - carry.length
    const hit = findEarliestMatch(buf, needles)
    if (hit !== null) {
      matchByte = bufStart + hit.index
      matchedBuf = hit.matched
      newlinesBeforeMatch = newlinesBeforeCarry + countNewlines(buf, hit.index)
      break
    }
    const keepLen = Math.min(buf.length, Math.max(0, maxNeedleLen - 1))
    const advance = buf.length - keepLen
    newlinesBeforeCarry += countNewlines(buf, advance)
    carry = keepLen > 0 ? Buffer.from(buf.subarray(advance)) : Buffer.alloc(0)
    position += bytesRead
  }

  if (matchByte === -1 || matchedBuf === null) {
    if (position >= MAX_SCAN_BYTES) {
      const probe = Buffer.allocUnsafe(1)
      const { bytesRead } = await handle.read(probe, 0, 1, position)
      if (bytesRead > 0) return { content: '', lineOffset: 1, truncated: true }
    }
    return { content: '', lineOffset: 1, truncated: false }
  }

  const safeContext = Math.max(0, contextLines)
  const beforeStart = Math.max(0, matchByte - CHUNK_SIZE)
  const { buffer: beforeBuf } = await readSpan(handle, beforeStart, matchByte - beforeStart)

  let foundNewlines = 0
  let earliestNl = -1
  for (let i = beforeBuf.length - 1; i >= 0; i--) {
    if (beforeBuf[i] === 10) {
      foundNewlines++
      earliestNl = i
      if (foundNewlines === safeContext + 1) break
    }
  }

  let beforeSlice: Buffer
  let newlinesInBefore: number
  if (foundNewlines === safeContext + 1) {
    beforeSlice = beforeBuf.subarray(earliestNl + 1)
    newlinesInBefore = safeContext
  } else if (beforeStart === 0) {
    beforeSlice = beforeBuf
    newlinesInBefore = foundNewlines
  } else if (earliestNl !== -1) {
    beforeSlice = beforeBuf.subarray(earliestNl + 1)
    newlinesInBefore = foundNewlines - 1
  } else {
    beforeSlice = trimLeadingUtf8Continuation(beforeBuf)
    newlinesInBefore = 0
  }

  const lineOffset = newlinesBeforeMatch - newlinesInBefore + 1
  const matchEndByte = matchByte + matchedBuf.length
  const neededAfter = needle.endsWith('\n') ? safeContext : safeContext + 1

  let afterSlice: Buffer = Buffer.alloc(0)
  if (neededAfter > 0) {
    const { buffer: afterBuf, reachedEof } = await readSpan(handle, matchEndByte, CHUNK_SIZE)
    let seenAfter = 0
    let lastNl = -1
    for (let i = 0; i < afterBuf.length; i++) {
      if (afterBuf[i] === 10) {
        seenAfter++
        lastNl = i
        if (seenAfter === neededAfter) break
      }
    }

    if (seenAfter === neededAfter) {
      const end = lastNl > 0 && afterBuf[lastNl - 1] === 13 ? lastNl - 1 : lastNl
      afterSlice = afterBuf.subarray(0, end)
    } else {
      const atEof = reachedEof || (await handle.stat()).size <= matchEndByte + afterBuf.length
      if (atEof) {
        afterSlice = afterBuf
      } else if (lastNl !== -1) {
        const end = lastNl > 0 && afterBuf[lastNl - 1] === 13 ? lastNl - 1 : lastNl
        afterSlice = afterBuf.subarray(0, end)
      } else {
        afterSlice = trimTrailingIncompleteUtf8(afterBuf)
      }
    }
  }

  const raw = Buffer.concat([beforeSlice, matchedBuf, afterSlice])
  const decoded = raw.toString('utf8')
  const content = decoded.slice(0, bytesToChars(decoded, raw.length)).replace(/\r\n/g, '\n')
  return { content, lineOffset, truncated: false }
}

function bytesToChars(text: string, bytes: number): number {
  if (bytes <= 0) return 0
  let count = 0
  let index = 0
  while (index < text.length && count < bytes) {
    const code = text.codePointAt(index) as number
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (count + width > bytes) break
    count += width
    index += code >= 0x10000 ? 2 : 1
  }
  return index
}

export async function readCapped(handle: FileHandle): Promise<string | null> {
  const info = await handle.stat()
  if (info.size > MAX_READ_BYTES) return null
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > MAX_READ_BYTES) return null
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    position += bytesRead
  }
  return Buffer.concat(chunks, total).toString('utf8').replace(/\r\n/g, '\n')
}
