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
): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0)
  const out = Buffer.allocUnsafe(maxBytes)
  let collected = 0
  while (collected < maxBytes) {
    const { bytesRead } = await handle.read(out, collected, maxBytes - collected, start + collected)
    if (bytesRead === 0) break
    collected += bytesRead
  }
  return out.subarray(0, collected)
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

  const wantedFeeds = Math.max(0, contextLines) + 1
  const beforeStart = Math.max(0, matchByte - CHUNK_SIZE)
  const beforeBuf = await readSpan(handle, beforeStart, matchByte - beforeStart)

  let feedsBefore = 0
  let beforeSlice = beforeBuf
  for (let i = beforeBuf.length - 1; i >= 0; i--) {
    if (beforeBuf[i] !== 10) continue
    feedsBefore++
    if (feedsBefore === wantedFeeds) {
      beforeSlice = beforeBuf.subarray(i + 1)
      feedsBefore--
      break
    }
  }

  const lineOffset = newlinesBeforeMatch - feedsBefore + 1
  const afterBuf = await readSpan(handle, matchByte + matchedBuf.length, CHUNK_SIZE)

  let feedsAfter = 0
  let afterSlice = afterBuf
  for (let i = 0; i < afterBuf.length; i++) {
    if (afterBuf[i] !== 10) continue
    feedsAfter++
    if (feedsAfter === wantedFeeds) {
      afterSlice = afterBuf.subarray(0, i + 1)
      break
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
